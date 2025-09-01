// addon.cpp

#include <napi.h>
#include <vector>
#include <complex>
#include <numeric>
#include <cmath>
#include <algorithm> 
#include "gaborator/gaborator.h"

// This function takes a multi-channel audio buffer and returns a spectrogram
// with perfectly padded data buffers and dimensions, ready for GPU textures.
Napi::Value analyze(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 4 || !info[0].IsTypedArray() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsObject()) {
        Napi::TypeError::New(env, "Expected: audioBuffer (TypedArray), channels (Number), sampleRate (Number), params (Object)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array inputBuffer = info[0].As<Napi::Float32Array>();
    int channels = info[1].As<Napi::Number>().Int32Value();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();
    Napi::Object paramsJs = info[3].As<Napi::Object>();
    size_t numSamplesInterleaved = inputBuffer.ElementLength();

    if (channels <= 0 || channels > 2) {
        Napi::TypeError::New(env, "Number of channels must be 1 or 2.").ThrowAsJavaScriptException();
        return env.Null();
    }
    size_t numFrames = numSamplesInterleaved / channels;

    std::vector<std::vector<float>> audioChannels(channels, std::vector<float>(numFrames));
    float* interleavedData = inputBuffer.Data();
    for (size_t i = 0; i < numFrames; ++i) {
        for (int ch = 0; ch < channels; ++ch) {
            audioChannels[ch][i] = interleavedData[i * channels + ch];
        }
    }

    int bandsPerOctave = paramsJs.Get("bandsPerOctave").As<Napi::Number>().Int32Value();
    double fminHz = paramsJs.Get("fmin").As<Napi::Number>().DoubleValue();
    double fminFrac = fminHz / sampleRate;
    gaborator::log_fq_scale scale(bandsPerOctave, fminFrac);
    gaborator::parameters params(scale);
    gaborator::analyzer<float> analyzer(params);

    int bandBegin = analyzer.bandpass_bands_begin();
    int numBands = analyzer.bandpass_bands_end() - bandBegin;
    if (numBands < 0) {
        Napi::Error::New(env, "Gaborator analysis resulted in a negative number of bands.").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::vector<uint32_t> bandOffsets(numBands);
    std::vector<int32_t> bandStepLog2s(numBands);
    std::vector<uint32_t> bandLengths(numBands);
    size_t totalComplexCoefficients = 0;

    for (int i = 0; i < numBands; ++i) {
        int gbno = bandBegin + i;
        int stepLog2 = analyzer.band_step_log2(gbno);
        size_t len = (numFrames > 0) ? ((numFrames - 1) >> stepLog2) + 1 : 0;
        bandOffsets[i] = static_cast<uint32_t>(totalComplexCoefficients);
        bandStepLog2s[i] = stepLog2;
        bandLengths[i] = static_cast<uint32_t>(len);
        totalComplexCoefficients += len;
    }

    // Calculate texture dimensions
    const int maxWidth = 4096;
    const int textureWidth = std::min((size_t)maxWidth, totalComplexCoefficients);
    const int textureHeight = (totalComplexCoefficients > 0) ? (totalComplexCoefficients + textureWidth - 1) / textureWidth : 0; // Ceiling division

    // Allocate perfectly sized, padded buffers
    size_t floatsPerPixel = 4;
    size_t paddedDataFloatCount = (size_t)textureWidth * textureHeight * floatsPerPixel;
    std::vector<float> paddedData(paddedDataFloatCount, 0.0f);

    size_t floatsPerMapPixel = 2;
    size_t paddedMapFloatCount = (size_t)textureWidth * textureHeight * floatsPerMapPixel;
    std::vector<float> paddedInverseMap(paddedMapFloatCount, 0.0f);

    size_t floatsPerMetaPixel = 3;
    size_t metadataFloatCount = (size_t)numBands * floatsPerMetaPixel;
    std::vector<float> metadataTexture(metadataFloatCount);

    // --- Populate Buffers ---

    // 1. Metadata Texture
    for (int i = 0; i < numBands; ++i) {
        metadataTexture[i * 3 + 0] = static_cast<float>(bandOffsets[i]);
        metadataTexture[i * 3 + 1] = static_cast<float>(bandLengths[i]);
        metadataTexture[i * 3 + 2] = static_cast<float>(bandStepLog2s[i]);
    }

    // 2. Inverse Map
    for (int bandIdx = 0; bandIdx < numBands; ++bandIdx) {
        uint64_t timeStep = 1ULL << bandStepLog2s[bandIdx];
        for (uint32_t i = 0; i < bandLengths[bandIdx]; ++i) {
            size_t linearPixelIndex = bandOffsets[bandIdx] + i;
            paddedInverseMap[linearPixelIndex * 2 + 0] = static_cast<float>(i * timeStep);
            paddedInverseMap[linearPixelIndex * 2 + 1] = static_cast<float>(bandIdx);
        }
    }

    // 3. Coefficient Data
    std::vector<gaborator::coefs<float>> allCoefs;
    allCoefs.reserve(channels);
    for (int ch = 0; ch < channels; ++ch) {
        allCoefs.emplace_back(analyzer);
        analyzer.analyze(audioChannels[ch].data(), 0, numFrames, allCoefs.back());
        gaborator::process(
            [&](int b, int64_t t, std::complex<float> &coef) {
                int bandIdx = b - bandBegin;
                if (bandIdx < 0 || bandIdx >= numBands) return;
                int64_t tInBand = t >> bandStepLog2s[bandIdx];
                if (tInBand < 0 || (size_t)tInBand >= bandLengths[bandIdx]) return;
                size_t baseOffset = bandOffsets[bandIdx] + tInBand;
                size_t writeOffset = baseOffset * floatsPerPixel;
                paddedData[writeOffset + ch * 2 + 0] = coef.real();
                paddedData[writeOffset + ch * 2 + 1] = coef.imag();
            },
            bandBegin, analyzer.bandpass_bands_end(), 0, numFrames, allCoefs[ch]
        );
    }
    
    // --- Assemble Return Object ---
    Napi::Object resultJs = Napi::Object::New(env);

    Napi::Float32Array dataJs = Napi::Float32Array::New(env, paddedData.size());
    memcpy(dataJs.Data(), paddedData.data(), paddedData.size() * sizeof(float));
    resultJs.Set("data", dataJs);

    Napi::Float32Array inverseMapJs = Napi::Float32Array::New(env, paddedInverseMap.size());
    memcpy(inverseMapJs.Data(), paddedInverseMap.data(), paddedInverseMap.size() * sizeof(float));
    resultJs.Set("inverseMap", inverseMapJs);

    Napi::Float32Array metadataTextureJs = Napi::Float32Array::New(env, metadataTexture.size());
    memcpy(metadataTextureJs.Data(), metadataTexture.data(), metadataTexture.size() * sizeof(float));
    resultJs.Set("metadataTexture", metadataTextureJs);

    resultJs.Set("textureWidth", Napi::Number::New(env, textureWidth));
    resultJs.Set("textureHeight", Napi::Number::New(env, textureHeight));
    resultJs.Set("numFrames", Napi::Number::New(env, numFrames));
    resultJs.Set("numChannels", Napi::Number::New(env, channels));
    resultJs.Set("numBands", Napi::Number::New(env, numBands));
    resultJs.Set("sampleRate", Napi::Number::New(env, sampleRate));
    
    // Keep raw metadata arrays for the synthesizer
    Napi::Uint32Array bandOffsetsJs = Napi::Uint32Array::New(env, bandOffsets.size());
    memcpy(bandOffsetsJs.Data(), bandOffsets.data(), bandOffsets.size() * sizeof(uint32_t));
    resultJs.Set("bandOffsets", bandOffsetsJs);

    Napi::Int32Array bandStepLog2sJs = Napi::Int32Array::New(env, bandStepLog2s.size());
    memcpy(bandStepLog2sJs.Data(), bandStepLog2s.data(), bandStepLog2s.size() * sizeof(int32_t));
    resultJs.Set("bandStepLog2s", bandStepLog2sJs);

    Napi::Uint32Array bandLengthsJs = Napi::Uint32Array::New(env, bandLengths.size());
    memcpy(bandLengthsJs.Data(), bandLengths.data(), bandLengths.size() * sizeof(uint32_t));
    resultJs.Set("bandLengths", bandLengthsJs);
    
    return resultJs;
}

Napi::Value synthesize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 5 || !info[0].IsTypedArray() || !info[1].IsObject() || !info[2].IsNumber() || !info[3].IsObject() || !info[4].IsBoolean()) {
        Napi::TypeError::New(env, "Expected: data (TypedArray), analysisObject (Object), sampleRate (Number), params (Object), normalize (Boolean)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array inputDataJs = info[0].As<Napi::Float32Array>();
    const float* inputData = inputDataJs.Data();
    Napi::Object analysisObj = info[1].As<Napi::Object>();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();
    Napi::Object paramsJs = info[3].As<Napi::Object>();
    bool normalize = info[4].As<Napi::Boolean>().Value();
    
    size_t numFrames = analysisObj.Get("numFrames").As<Napi::Number>().Int64Value();
    int channels = analysisObj.Get("numChannels").As<Napi::Number>().Int32Value();
    int numBands = analysisObj.Get("numBands").As<Napi::Number>().Int32Value();
    Napi::Uint32Array bandOffsetsJs = analysisObj.Get("bandOffsets").As<Napi::Uint32Array>();
    const uint32_t* bandOffsets = bandOffsetsJs.Data();
    Napi::Uint32Array bandLengthsJs = analysisObj.Get("bandLengths").As<Napi::Uint32Array>();
    const uint32_t* bandLengths = bandLengthsJs.Data();
    Napi::Int32Array bandStepLog2sJs = analysisObj.Get("bandStepLog2s").As<Napi::Int32Array>();
    const int32_t* bandStepLog2s = bandStepLog2sJs.Data();

    int bandsPerOctave = paramsJs.Get("bandsPerOctave").As<Napi::Number>().Int32Value();
    double fminHz = paramsJs.Get("fmin").As<Napi::Number>().DoubleValue();
    double fminFrac = fminHz / sampleRate;
    gaborator::log_fq_scale scale(bandsPerOctave, fminFrac);
    gaborator::parameters params(scale);
    gaborator::analyzer<float> analyzer(params);

    int band_begin = analyzer.bandpass_bands_begin();
    int band_end = analyzer.bandpass_bands_end();

    std::vector<std::vector<float>> audioChannels(channels);
    size_t floatsPerPixel = 4;

    for (int ch = 0; ch < channels; ++ch) {
        gaborator::coefs<float> channelCoefs(analyzer);
        gaborator::fill(
            [&](int b, int64_t t, std::complex<float> &coef) {
                int band_idx = b - band_begin;
                if (band_idx < 0 || band_idx >= numBands) {
                    coef = {0.0f, 0.0f}; return;
                }
                int64_t t_in_band = t >> bandStepLog2s[band_idx];
                if (t_in_band < 0 || (size_t)t_in_band >= (size_t)bandLengths[band_idx]) {
                    coef = {0.0f, 0.0f}; return;
                }
                size_t base_offset = bandOffsets[band_idx] + t_in_band;
                size_t readOffset = base_offset * floatsPerPixel;
                coef.real(inputData[readOffset + ch * 2 + 0]);
                coef.imag(inputData[readOffset + ch * 2 + 1]);
            },
            band_begin, band_end, 0, numFrames, channelCoefs
        );
        audioChannels[ch].resize(numFrames);
        analyzer.synthesize(channelCoefs, 0, numFrames, audioChannels[ch].data());
    }

    float normalization_factor = 1.0f;
    if (normalize) {
        // Find the peak absolute value across all channels.
        float peak_value = 0.0f;
        for (const auto& channel_data : audioChannels) {
            for (float sample : channel_data) {
                peak_value = std::max(peak_value, std::abs(sample));
            }
        }

        if (peak_value > 0.0f) {
            normalization_factor = 1.0f / peak_value;
        }
    }

    size_t numSamplesInterleaved = numFrames * channels;
    Napi::Float32Array outputBuffer = Napi::Float32Array::New(env, numSamplesInterleaved);
    
    // Apply the normalization factor while interleaving the final buffer.
    for (size_t i = 0; i < numFrames; ++i) {
        for (int ch = 0; ch < channels; ++ch) {
            outputBuffer[i * channels + ch] = audioChannels[ch][i] * normalization_factor;
        }
    }
    return outputBuffer;
}

Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("analyze", Napi::Function::New(env, analyze));
  exports.Set("synthesize", Napi::Function::New(env, synthesize));
  return exports;
}

NODE_API_MODULE(gaborator_addon, init);