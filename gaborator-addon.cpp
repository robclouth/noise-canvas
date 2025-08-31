#include <napi.h>
#include <vector>
#include <cmath>
#include <complex>
#include <algorithm>
#include "gaborator/gaborator.h"
#include "gaborator/render.h"

// Define a function object to return the complex number itself
template <class T>
struct complex_identity_fob {
    std::complex<T> operator()(const std::complex<T> &c) const {
        return c;
    }
    typedef std::complex<T> return_type;
};

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
    gaborator::analyzer<float> analyzer(params);

    // 4. Analyze and render channels in pairs
    int64_t x0 = 0;
    int64_t y0 = 0;
    int64_t x1 = numFrames;
    int64_t y1 = (analyzer.bandpass_bands_end() - analyzer.bandpass_bands_begin());
    int64_t width = x1 - x0;
    int64_t height = y1 - y0;

    if (channels == 0) {
        Napi::Object resultJs = Napi::Object::New(env);
        resultJs.Set("textures", Napi::Array::New(env, 0));
        resultJs.Set("width", Napi::Number::New(env, 0));
        resultJs.Set("height", Napi::Number::New(env, 0));
        return resultJs;
    }

    // --- Process left channel (ch 0) ---
    gaborator::coefs<float> coefsLeft(analyzer);
    analyzer.analyze(audioChannels[0].data(), 0, numFrames, coefsLeft);

    int64_t xOrigin = 0;
    int64_t yOrigin = 0;
    int xScaleExp = 0; // Full width
    int yScaleExp = 0; // Full height

    std::vector<std::complex<float>> complexDataLeft(width * height);

    gaborator::render_p2scale(
        analyzer,
        coefsLeft,
        xOrigin, yOrigin,
        x0, x1, xScaleExp,
        y0, y1, yScaleExp,
        complexDataLeft.data(),
        complex_identity_fob<float>()
    );

    // --- Process right channel (ch 1) if it exists ---
    std::vector<std::complex<float>> complexDataRight;
    bool hasRightChannel = channels > 1;
    if (hasRightChannel) {
        complexDataRight.resize(width * height);
        gaborator::coefs<float> coefsRight(analyzer);
        analyzer.analyze(audioChannels[1].data(), 0, numFrames, coefsRight);
        gaborator::render_p2scale(
            analyzer,
            coefsRight,
            xOrigin, yOrigin,
            x0, x1, xScaleExp,
            y0, y1, yScaleExp,
            complexDataRight.data(),
            complex_identity_fob<float>()
        );
    }

    // --- Combine into textures ---
    const int maxTextureWidth = 4096;
    Napi::Array texturesJs = Napi::Array::New(env);
    int textureIdxCounter = 0;

    for (int64_t xOffset = 0; xOffset < width; xOffset += maxTextureWidth) {
        int64_t currentWidth = std::min((int64_t)maxTextureWidth, width - xOffset);
        
        std::vector<float> textureData(currentWidth * height * 4);

        for (int64_t y = 0; y < height; ++y) {
            for (int64_t x = 0; x < currentWidth; ++x) {
                int64_t complexIdx = (y * width) + (xOffset + x);
                int64_t textureRgbaIdx = (y * currentWidth + x) * 4;
                
                const auto& cLeft = complexDataLeft[complexIdx];
                textureData[textureRgbaIdx + 0] = cLeft.real(); // R
                textureData[textureRgbaIdx + 1] = cLeft.imag(); // G

                if (hasRightChannel) {
                    const auto& cRight = complexDataRight[complexIdx];
                    textureData[textureRgbaIdx + 2] = cRight.real();     // B
                    textureData[textureRgbaIdx + 3] = cRight.imag();     // A
                } else {
                    textureData[textureRgbaIdx + 2] = 0.0f;     // B
                    textureData[textureRgbaIdx + 3] = 0.0f;     // A
                }
            }
        }

        Napi::Float32Array dataJs = Napi::Float32Array::New(env, textureData.size());
        memcpy(dataJs.Data(), textureData.data(), textureData.size() * sizeof(float));
        
        Napi::Object textureJs = Napi::Object::New(env);
        textureJs.Set("data", dataJs);
        textureJs.Set("width", Napi::Number::New(env, currentWidth));
        textureJs.Set("height", Napi::Number::New(env, height));
        
        texturesJs[textureIdxCounter++] = textureJs;
    }

    Napi::Object resultJs = Napi::Object::New(env);
    resultJs.Set("textures", texturesJs);
    resultJs.Set("width", Napi::Number::New(env, width));
    resultJs.Set("height", Napi::Number::New(env, height));
    resultJs.Set("channels", Napi::Number::New(env, channels));
    
    return resultJs;
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
        int64_t currentT = 0; 
        
        gaborator::fill(
            [&](int b, int64_t t, std::complex<float> &coef) {
                Napi::Float32Array coefsJs = bandsJs.Get(b).As<Napi::Float32Array>();
                int64_t tOffset = t - currentT;
                if(tOffset >= 0 && (size_t)tOffset < coefsJs.ElementLength()/2) {
                    coef.real(coefsJs[(size_t)tOffset * 2]);
                    coef.imag(coefsJs[(size_t)tOffset * 2 + 1]);
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
