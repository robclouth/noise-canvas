// addon.cpp

#include <napi.h>
#include <vector>
#include <complex>
#include <numeric>
#include <cmath>
#include <algorithm> 
#include "gaborator/gaborator.h"

class AnalyzeWorker : public Napi::AsyncWorker {
public:
    AnalyzeWorker(Napi::Env env, const Napi::Float32Array& inputBuffer, int channels, double sampleRate, const Napi::Object& paramsJs)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), channels(channels), sampleRate(sampleRate) {
        
        interleavedData.assign(inputBuffer.Data(), inputBuffer.Data() + inputBuffer.ElementLength());
        bandsPerOctave = paramsJs.Get("bandsPerOctave").As<Napi::Number>().Int32Value();
        fminHz = paramsJs.Get("minFreq").As<Napi::Number>().DoubleValue();
    }

    ~AnalyzeWorker() {}

    void Execute() {
        size_t numSamplesInterleaved = interleavedData.size();
        if (channels <= 0) {
            SetError("Number of channels must be positive.");
            return;
        }
        numFrames = numSamplesInterleaved / channels;

        std::vector<std::vector<float>> audioChannels(channels, std::vector<float>(numFrames));
        for (size_t i = 0; i < numFrames; ++i) {
            for (int ch = 0; ch < channels; ++ch) {
                audioChannels[ch][i] = interleavedData[i * channels + ch];
            }
        }

        double fminFrac = fminHz / sampleRate;
        gaborator::log_fq_scale scale(bandsPerOctave, fminFrac);
        double overlap = 0.8;
        gaborator::parameters params(scale, overlap);
        gaborator::analyzer<float> analyzer(params);

        int bandBegin = analyzer.bandpass_bands_begin();
        numBands = analyzer.bandpass_bands_end() - bandBegin;
        if (numBands < 0) {
            SetError("Gaborator analysis resulted in a negative number of bands.");
            return;
        }

        bandOffsets.resize(numBands);
        bandStepLog2s.resize(numBands);
        bandLengths.resize(numBands);
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

        const int maxWidth = 4096;
        const int maxHeight = 4096;
        textureWidth = std::min((size_t)maxWidth, totalComplexCoefficients);
        textureHeight = (totalComplexCoefficients > 0) ? (totalComplexCoefficients + textureWidth - 1) / textureWidth : 0;
        
        // Check if we need to clamp the texture height
        this->isClamped = textureHeight > maxHeight;
        this->clampedDurationSeconds = 0.0;
        size_t clampedComplexCoefficients = totalComplexCoefficients;
        
        if (this->isClamped) {
            textureHeight = maxHeight;
            clampedComplexCoefficients = (size_t)maxWidth * maxHeight;
            // Calculate the actual duration that fits in the texture
            // The ratio of clamped coefficients to total gives us the proportion of the file kept
            double ratio = (double)clampedComplexCoefficients / (double)totalComplexCoefficients;
            this->clampedDurationSeconds = ratio * ((double)numFrames / sampleRate);
        }

        size_t floatsPerPixel = 4;
        size_t paddedDataFloatCount = (size_t)textureWidth * textureHeight * floatsPerPixel;
        paddedData.assign(paddedDataFloatCount, 0.0f);

        size_t floatsPerMapPixel = 2;
        size_t paddedMapFloatCount = (size_t)textureWidth * textureHeight * floatsPerMapPixel;
        paddedInverseMap.assign(paddedMapFloatCount, 0.0f);

        size_t maxPixelIndex = (size_t)textureWidth * textureHeight;
        
        // If clamped, update bandLengths and numFrames to reflect actual stored data
        if (this->isClamped) {
            for (int bandIdx = 0; bandIdx < numBands; ++bandIdx) {
                size_t bandStart = bandOffsets[bandIdx];
                size_t bandEnd = bandStart + bandLengths[bandIdx];
                if (bandEnd > maxPixelIndex) {
                    if (bandStart >= maxPixelIndex) {
                        bandLengths[bandIdx] = 0;
                    } else {
                        bandLengths[bandIdx] = static_cast<uint32_t>(maxPixelIndex - bandStart);
                    }
                }
            }
            // Update numFrames to reflect the clamped duration
            numFrames = static_cast<size_t>(this->clampedDurationSeconds * sampleRate);
        }
        
        size_t floatsPerMetaPixel = 3;
        size_t metadataFloatCount = (size_t)numBands * floatsPerMetaPixel;
        metadataTexture.resize(metadataFloatCount);

        for (int i = 0; i < numBands; ++i) {
            metadataTexture[i * 3 + 0] = static_cast<float>(bandOffsets[i]);
            metadataTexture[i * 3 + 1] = static_cast<float>(bandLengths[i]);
            metadataTexture[i * 3 + 2] = static_cast<float>(bandStepLog2s[i]);
        }
        
        for (int bandIdx = 0; bandIdx < numBands; ++bandIdx) {
            uint64_t timeStep = 1ULL << bandStepLog2s[bandIdx];
            for (uint32_t i = 0; i < bandLengths[bandIdx]; ++i) {
                size_t linearPixelIndex = bandOffsets[bandIdx] + i;
                paddedInverseMap[linearPixelIndex * 2 + 0] = static_cast<float>(i * timeStep);
                paddedInverseMap[linearPixelIndex * 2 + 1] = static_cast<float>(bandIdx);
            }
        }

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
                    // Only write if within the clamped texture bounds
                    if (baseOffset >= maxPixelIndex) return;
                    size_t writeOffset = baseOffset * floatsPerPixel;
                    paddedData[writeOffset + ch * 2 + 0] = coef.real();
                    paddedData[writeOffset + ch * 2 + 1] = coef.imag();
                },
                bandBegin, analyzer.bandpass_bands_end(), 0, numFrames, allCoefs[ch]
            );
        }
    }

    void OnOK() {
        Napi::Env env = Env();
        Napi::HandleScope scope(env);
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

        Napi::Uint32Array bandOffsetsJs = Napi::Uint32Array::New(env, bandOffsets.size());
        memcpy(bandOffsetsJs.Data(), bandOffsets.data(), bandOffsets.size() * sizeof(uint32_t));
        resultJs.Set("bandOffsets", bandOffsetsJs);

        Napi::Int32Array bandStepLog2sJs = Napi::Int32Array::New(env, bandStepLog2s.size());
        memcpy(bandStepLog2sJs.Data(), bandStepLog2s.data(), bandStepLog2s.size() * sizeof(int32_t));
        resultJs.Set("bandStepLog2s", bandStepLog2sJs);

        Napi::Uint32Array bandLengthsJs = Napi::Uint32Array::New(env, bandLengths.size());
        memcpy(bandLengthsJs.Data(), bandLengths.data(), bandLengths.size() * sizeof(uint32_t));
        resultJs.Set("bandLengths", bandLengthsJs);

        resultJs.Set("isClamped", Napi::Boolean::New(env, isClamped));
        resultJs.Set("clampedDurationSeconds", Napi::Number::New(env, clampedDurationSeconds));

        deferred.Resolve(resultJs);
    }

    void OnError(const Napi::Error& e) {
        deferred.Reject(e.Value());
    }

    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    std::vector<float> interleavedData;
    int channels;
    double sampleRate;
    int bandsPerOctave;
    double fminHz;

    // Results
    std::vector<float> paddedData;
    std::vector<float> paddedInverseMap;
    std::vector<float> metadataTexture;
    int textureWidth;
    int textureHeight;
    size_t numFrames;
    int numBands;
    std::vector<uint32_t> bandOffsets;
    std::vector<int32_t> bandStepLog2s;
    std::vector<uint32_t> bandLengths;
    bool isClamped;
    double clampedDurationSeconds;
};

Napi::Value AnalyzeAsync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 4 || !info[0].IsTypedArray() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsObject()) {
        Napi::TypeError::New(env, "Expected: audioBuffer (TypedArray), channels (Number), sampleRate (Number), params (Object)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array inputBuffer = info[0].As<Napi::Float32Array>();
    int channels = info[1].As<Napi::Number>().Int32Value();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();
    Napi::Object paramsJs = info[3].As<Napi::Object>();

    if (!paramsJs.Has("bandsPerOctave") || !paramsJs.Get("bandsPerOctave").IsNumber()) {
        Napi::TypeError::New(env, "params.bandsPerOctave is missing or not a number").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (!paramsJs.Has("minFreq") || !paramsJs.Get("minFreq").IsNumber()) {
        Napi::TypeError::New(env, "params.minFreq is missing or not a number").ThrowAsJavaScriptException();
        return env.Null();
    }

    if (channels <= 0 || channels > 2) {
        Napi::TypeError::New(env, "Number of channels must be 1 or 2.").ThrowAsJavaScriptException();
        return env.Null();
    }

    AnalyzeWorker* worker = new AnalyzeWorker(env, inputBuffer, channels, sampleRate, paramsJs);
    worker->Queue();
    return worker->GetPromise();
}

class SynthesizeWorker : public Napi::AsyncWorker {
public:
    SynthesizeWorker(Napi::Env env,
                     const Napi::Float32Array& inputDataJs,
                     const Napi::Object& analysisObj,
                     double sampleRate,
                     const Napi::Object& paramsJs,
                     bool normalize)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), sampleRate(sampleRate), normalize(normalize) {

        inputData.assign(inputDataJs.Data(), inputDataJs.Data() + inputDataJs.ElementLength());
        
        numFrames = analysisObj.Get("numFrames").As<Napi::Number>().Int64Value();
        channels = analysisObj.Get("numChannels").As<Napi::Number>().Int32Value();
        numBands = analysisObj.Get("numBands").As<Napi::Number>().Int32Value();
        
        Napi::Uint32Array bandOffsetsJs = analysisObj.Get("bandOffsets").As<Napi::Uint32Array>();
        bandOffsets.assign(bandOffsetsJs.Data(), bandOffsetsJs.Data() + bandOffsetsJs.ElementLength());
        
        Napi::Uint32Array bandLengthsJs = analysisObj.Get("bandLengths").As<Napi::Uint32Array>();
        bandLengths.assign(bandLengthsJs.Data(), bandLengthsJs.Data() + bandLengthsJs.ElementLength());

        Napi::Int32Array bandStepLog2sJs = analysisObj.Get("bandStepLog2s").As<Napi::Int32Array>();
        bandStepLog2s.assign(bandStepLog2sJs.Data(), bandStepLog2sJs.Data() + bandStepLog2sJs.ElementLength());

        bandsPerOctave = paramsJs.Get("bandsPerOctave").As<Napi::Number>().Int32Value();
        fminHz = paramsJs.Get("minFreq").As<Napi::Number>().DoubleValue();
    }

    ~SynthesizeWorker() {}

    void Execute() {
        double fminFrac = fminHz / sampleRate;
        gaborator::log_fq_scale scale(bandsPerOctave, fminFrac);
        double overlap = 0.8;
        gaborator::parameters params(scale, overlap);
        gaborator::analyzer<float> analyzer(params);

        int band_begin = analyzer.bandpass_bands_begin();
        int band_end = analyzer.bandpass_bands_end();

        audioChannels.resize(channels);
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

        if (normalize) {
            float peak_value = 0.0f;
            for (const auto& channel_data : audioChannels) {
                for (float sample : channel_data) {
                    peak_value = std::max(peak_value, std::abs(sample));
                }
            }
            float normalization_factor = 1.0f;
            if (peak_value > 0.0f) {
                normalization_factor = 1.0f / peak_value;
            }
            for (auto& channel_data : audioChannels) {
                for (float& sample : channel_data) {
                    sample *= normalization_factor;
                }
            }
        }
    }

    void OnOK() {
        Napi::Env env = Env();
        Napi::HandleScope scope(env);

        Napi::Array outputChannels = Napi::Array::New(env, channels);
        for (int ch = 0; ch < channels; ++ch) {
            Napi::Float32Array channelBuffer = Napi::Float32Array::New(env, numFrames);
            memcpy(channelBuffer.Data(), audioChannels[ch].data(), numFrames * sizeof(float));
            outputChannels[ch] = channelBuffer;
        }
        deferred.Resolve(outputChannels);
    }

    void OnError(const Napi::Error& e) {
        deferred.Reject(e.Value());
    }

    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;

    // Input data
    std::vector<float> inputData;
    double sampleRate;
    bool normalize;
    size_t numFrames;
    int channels;
    int numBands;
    std::vector<uint32_t> bandOffsets;
    std::vector<uint32_t> bandLengths;
    std::vector<int32_t> bandStepLog2s;
    int bandsPerOctave;
    double fminHz;

    // Results
    std::vector<std::vector<float>> audioChannels;
};

Napi::Value SynthesizeAsync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 5 || !info[0].IsTypedArray() || !info[1].IsObject() || !info[2].IsNumber() || !info[3].IsObject() || !info[4].IsBoolean()) {
        Napi::TypeError::New(env, "Expected: data (TypedArray), analysisObject (Object), sampleRate (Number), params (Object), normalize (Boolean)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array inputDataJs = info[0].As<Napi::Float32Array>();
    Napi::Object analysisObj = info[1].As<Napi::Object>();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();
    Napi::Object paramsJs = info[3].As<Napi::Object>();
    bool normalize = info[4].As<Napi::Boolean>().Value();

    if (!paramsJs.Has("bandsPerOctave") || !paramsJs.Get("bandsPerOctave").IsNumber()) {
        Napi::TypeError::New(env, "params.bandsPerOctave is missing or not a number").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (!paramsJs.Has("minFreq") || !paramsJs.Get("minFreq").IsNumber()) {
        Napi::TypeError::New(env, "params.minFreq is missing or not a number").ThrowAsJavaScriptException();
        return env.Null();
    }

    SynthesizeWorker* worker = new SynthesizeWorker(env, inputDataJs, analysisObj, sampleRate, paramsJs, normalize);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("analyze", Napi::Function::New(env, AnalyzeAsync));
  exports.Set("synthesize", Napi::Function::New(env, SynthesizeAsync));
  return exports;
}

NODE_API_MODULE(gaborator_addon, init);