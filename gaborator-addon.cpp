// addon.cpp

#include <napi.h>
#include <vector>
#include <complex>
#include <numeric>
#include "gaborator/gaborator.h"

// This function takes a multi-channel audio buffer and returns a spectrogram
// as a single flat Float32Array with all metadata needed for shader-based rendering.
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

    if (numFrames == 0) {
        Napi::Error::New(env, "Number of frames must be greater than 0.").ThrowAsJavaScriptException();
        return env.Null();
    }

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

    std::vector<gaborator::coefs<float>> allCoefs;
    allCoefs.reserve(channels);
    for (int ch = 0; ch < channels; ++ch) {
        allCoefs.emplace_back(analyzer);
        analyzer.analyze(audioChannels[ch].data(), 0, numFrames, allCoefs.back());
    }

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

    // Each "pixel" in the texture will be RGBA.
    // For mono, we use 2 floats (R,G) and pad with 2 zeros (B,A).
    // For stereo, we use 4 floats (L_R, L_I, R_R, R_I).
    size_t floatsPerPixel = 4;
    size_t totalFloats = totalComplexCoefficients * floatsPerPixel;
    std::vector<float> interleavedOutput(totalFloats, 0.0f); // Initialize with zeros for padding

    for (int ch = 0; ch < channels; ++ch) {
        gaborator::process(
            [&](int b, int64_t t, std::complex<float> &coef) {
                int bandIdx = b - bandBegin;
                if (bandIdx < 0 || bandIdx >= numBands) return;

                int64_t tInBand = t >> bandStepLog2s[bandIdx];

                if (tInBand < 0 || (size_t)tInBand >= bandLengths[bandIdx]) return;

                size_t baseOffset = bandOffsets[bandIdx] + tInBand;
                size_t writeOffset = baseOffset * floatsPerPixel;
                
                interleavedOutput[writeOffset + ch * 2 + 0] = coef.real();
                interleavedOutput[writeOffset + ch * 2 + 1] = coef.imag();
            },
            bandBegin, analyzer.bandpass_bands_end(),
            0, numFrames,
            allCoefs[ch]
        );
    }
    
    Napi::Object metaJs = Napi::Object::New(env);
    metaJs.Set("numChannels", Napi::Number::New(env, channels));
    metaJs.Set("numBands", Napi::Number::New(env, numBands));

    Napi::Uint32Array bandOffsetsJs = Napi::Uint32Array::New(env, bandOffsets.size());
    memcpy(bandOffsetsJs.Data(), bandOffsets.data(), bandOffsets.size() * sizeof(uint32_t));
    metaJs.Set("bandOffsets", bandOffsetsJs);

    Napi::Int32Array bandStepLog2sJs = Napi::Int32Array::New(env, bandStepLog2s.size());
    memcpy(bandStepLog2sJs.Data(), bandStepLog2s.data(), bandStepLog2s.size() * sizeof(int32_t));
    metaJs.Set("bandStepLog2s", bandStepLog2sJs);

    Napi::Uint32Array bandLengthsJs = Napi::Uint32Array::New(env, bandLengths.size());
    memcpy(bandLengthsJs.Data(), bandLengths.data(), bandLengths.size() * sizeof(uint32_t));
    metaJs.Set("bandLengths", bandLengthsJs);

    Napi::Object resultJs = Napi::Object::New(env);
    Napi::Float32Array dataJs = Napi::Float32Array::New(env, interleavedOutput.size());
    memcpy(dataJs.Data(), interleavedOutput.data(), interleavedOutput.size() * sizeof(float));
    
    resultJs.Set("data", dataJs);
    resultJs.Set("metadata", metaJs);
    
    return resultJs;
}

// This function takes a spectrogram (as a flat buffer with metadata)
// and returns a multi-channel audio buffer.
Napi::Value synthesize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 5 || !info[0].IsTypedArray() || !info[1].IsObject() || !info[2].IsNumber() || !info[3].IsObject() || !info[4].IsNumber()) {
        Napi::TypeError::New(env, "Expected: data (TypedArray), metadata (Object), sampleRate (Number), params (Object), numFrames (Number)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array inputDataJs = info[0].As<Napi::Float32Array>();
    const float* inputData = inputDataJs.Data();
    Napi::Object metaJs = info[1].As<Napi::Object>();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();
    Napi::Object paramsJs = info[3].As<Napi::Object>();
    size_t numFrames = info[4].As<Napi::Number>().Int64Value();

    int channels = metaJs.Get("numChannels").As<Napi::Number>().Int32Value();
    int numBands = metaJs.Get("numBands").As<Napi::Number>().Int32Value();
    Napi::Uint32Array bandOffsetsJs = metaJs.Get("bandOffsets").As<Napi::Uint32Array>();
    const uint32_t* bandOffsets = bandOffsetsJs.Data();
    Napi::Uint32Array bandLengthsJs = metaJs.Get("bandLengths").As<Napi::Uint32Array>();
    const uint32_t* bandLengths = bandLengthsJs.Data();

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
                int step_log2 = analyzer.band_step_log2(b);
                int64_t t_in_band = t >> step_log2;
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

    size_t numSamplesInterleaved = numFrames * channels;
    Napi::Float32Array outputBuffer = Napi::Float32Array::New(env, numSamplesInterleaved);
    for (size_t i = 0; i < numFrames; ++i) {
        for (int ch = 0; ch < channels; ++ch) {
            outputBuffer[i * channels + ch] = audioChannels[ch][i];
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