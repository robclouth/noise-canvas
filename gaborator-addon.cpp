#include <napi.h>
#include <vector>
#include "gaborator/gaborator.h"

// This function will take a multi-channel audio buffer and return a spectrogram
Napi::Value Analyze(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Basic argument checking
    if (info.Length() < 4 || !info[0].IsTypedArray() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsObject()) {
        Napi::TypeError::New(env, "Expected AudioBuffer (TypedArray), channels (Number), sampleRate (Number), params (Object)").ThrowAsJavaScriptException();
        return env.Null();
    }

    // 1. Get arguments from JavaScript
    Napi::Float32Array inputBuffer = info[0].As<Napi::Float32Array>();
    int channels = info[1].As<Napi::Number>().Int32Value();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();
    Napi::Object paramsJs = info[3].As<Napi::Object>();
    size_t numSamplesInterleaved = inputBuffer.ElementLength();
    size_t numFrames = numSamplesInterleaved / channels;

    // 2. De-interleave the audio buffer
    std::vector<std::vector<float>> audioChannels(channels, std::vector<float>(numFrames));
    float* interleavedData = inputBuffer.Data();
    for (size_t i = 0; i < numSamplesInterleaved; ++i) {
        audioChannels[i % channels][i / channels] = interleavedData[i];
    }

    // 3. Set up Gaborator parameters from JavaScript
    int bandsPerOctave = paramsJs.Get("bandsPerOctave").As<Napi::Number>().Int32Value();
    double fminHz = paramsJs.Get("fmin").As<Napi::Number>().DoubleValue();
    double fminFrac = fminHz / sampleRate;
    gaborator::log_fq_scale scale(bandsPerOctave, fminFrac);
    gaborator::parameters params(scale);

    // 4. Analyze each channel and store coefficients
    Napi::Array spectrogramJs = Napi::Array::New(env, channels);
    for (int ch = 0; ch < channels; ++ch) {
        gaborator::analyzer<float> analyzer(params);
        gaborator::coefs<float> channelCoefs(analyzer);

        // Analyze the entire channel at once
        analyzer.analyze(audioChannels[ch].data(), 0, numFrames, channelCoefs);

        // 5. Convert coefficients to a JavaScript-friendly format
        int numBands = analyzer.bands_end();
        std::vector<std::vector<std::complex<float>>> spectrogramData(numBands);

        // Use gaborator::process to iterate over all coefficients and populate our structure
        gaborator::process(
            [&](int b, int64_t /*t*/, std::complex<float> &coef) {
                if (b >= 0 && b < numBands) {
                    spectrogramData[b].push_back(coef);
                }
            },
            INT_MIN, INT_MAX, INT64_MIN, INT64_MAX,
            channelCoefs
        );

        // 6. Convert the C++ structure to a JavaScript-friendly format
        Napi::Array bandsJs = Napi::Array::New(env, numBands);
        for (int bandIdx = 0; bandIdx < numBands; ++bandIdx) {
            const auto& bandCoefVec = spectrogramData[bandIdx];
            size_t nCoefs = bandCoefVec.size();

            // Create a Float32Array for the coefficients (real, imag interleaved)
            Napi::Float32Array coefsJs = Napi::Float32Array::New(env, nCoefs * 2);
            
            for (size_t i = 0; i < nCoefs; ++i) {
                coefsJs[i * 2] = bandCoefVec[i].real();
                coefsJs[i * 2 + 1] = bandCoefVec[i].imag();
            }
            bandsJs[bandIdx] = coefsJs;
        }
        spectrogramJs[ch] = bandsJs;
    }

    return spectrogramJs;
}


// This function will take a spectrogram and return a multi-channel audio buffer
Napi::Value Synthesize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 5 || !info[0].IsArray() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsObject()) {
        Napi::TypeError::New(env, "Expected Spectrogram (Array), channels (Number), sampleRate (Number), num_frames (Number), params (Object)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Array spectrogramJs = info[0].As<Napi::Array>();
    int channels = info[1].As<Napi::Number>().Int32Value();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();
    size_t numFrames = info[3].As<Napi::Number>().Int64Value();
    Napi::Object paramsJs = info[4].As<Napi::Object>();

    int bandsPerOctave = paramsJs.Get("bandsPerOctave").As<Napi::Number>().Int32Value();
    double fminHz = paramsJs.Get("fmin").As<Napi::Number>().DoubleValue();
    double fminFrac = fminHz / sampleRate;
    gaborator::log_fq_scale scale(bandsPerOctave, fminFrac);
    gaborator::parameters params(scale);

    std::vector<std::vector<float>> audioChannels(channels);
    size_t numSamplesInterleaved = numFrames * channels;

    for (int ch = 0; ch < channels; ++ch) {
        gaborator::analyzer<float> analyzer(params);
        gaborator::coefs<float> channelCoefs(analyzer);

        Napi::Array bandsJs = spectrogramJs.Get(ch).As<Napi::Array>();
        int numBands = bandsJs.Length();
        int64_t current_t = 0; 
        
        gaborator::fill(
            [&](int b, int64_t t, std::complex<float> &coef) {
                Napi::Float32Array coefsJs = bandsJs.Get(b).As<Napi::Float32Array>();
                int64_t t_offset = t - current_t;
                if(t_offset >= 0 && (size_t)t_offset < coefsJs.ElementLength()/2) {
                    coef.real(coefsJs[(size_t)t_offset * 2]);
                    coef.imag(coefsJs[(size_t)t_offset * 2 + 1]);
                }
            },
            0, numBands,
            0, numFrames, 
            channelCoefs
        );

        audioChannels[ch].resize(numFrames);
        analyzer.synthesize(channelCoefs, 0, numFrames, audioChannels[ch].data());
    }

    Napi::Float32Array outputBuffer = Napi::Float32Array::New(env, numSamplesInterleaved);
    for (size_t i = 0; i < numSamplesInterleaved; ++i) {
        outputBuffer[i] = audioChannels[i % channels][i / channels];
    }

    return outputBuffer;
}


Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("analyze", Napi::Function::New(env, Analyze));
  exports.Set("synthesize", Napi::Function::New(env, Synthesize));
  return exports;
}

NODE_API_MODULE(gaborator_addon, Init)
