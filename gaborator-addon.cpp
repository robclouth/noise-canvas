// addon.cpp

#include <napi.h>
#include <vector>
#include <complex>
#include <numeric>
#include <cmath>
#include <algorithm>
#include <string>   // For std::string
#include <sstream>  // For std::stringstream
#include <iomanip>  // For std::fixed, std::setprecision
#include <iostream> // For std::cerr
#include <fstream>  // For file logging
#include "gaborator/gaborator.h"

#define OVERLAP 0.7
#define MAX_TEXTURE_SIZE 4096

// Debug logging to file
static std::ofstream &getDebugLog()
{
    static std::ofstream debugLog("/tmp/gaborator_debug.log", std::ios::out | std::ios::app);
    return debugLog;
}

#define DEBUG_LOG getDebugLog()

class AnalyzeWorker : public Napi::AsyncWorker
{
public:
    AnalyzeWorker(Napi::Env env, const Napi::Array &planarInput, int channels, double sampleRate, const Napi::Object &paramsJs)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), channels(channels), sampleRate(sampleRate)
    {
        size_t length = planarInput.Get(0u).As<Napi::Float32Array>().ElementLength();
        audioChannels.resize(channels);
        for (int ch = 0; ch < channels; ++ch)
        {
            Napi::Float32Array channelData = planarInput.Get(static_cast<uint32_t>(ch)).As<Napi::Float32Array>();
            audioChannels[ch].assign(channelData.Data(), channelData.Data() + length);
        }
        numFrames = length;
        bandsPerOctave = paramsJs.Get("bandsPerOctave").As<Napi::Number>().Int32Value();
        fminHz = paramsJs.Get("minFreq").As<Napi::Number>().DoubleValue();
    }

    ~AnalyzeWorker() {}

    void Execute()
    {
        if (channels <= 0)
        {
            SetError("Number of channels must be positive.");
            return;
        }

        double fminFrac = fminHz / sampleRate;
        gaborator::log_fq_scale scale(bandsPerOctave, fminFrac);
        gaborator::parameters params(scale, OVERLAP);
        params.phase = gaborator::coef_phase::global;
        gaborator::analyzer<float> analyzer(params);

        int bandBegin = analyzer.bandpass_bands_begin();
        numBands = analyzer.bandpass_bands_end() - bandBegin;
        if (numBands < 0)
        {
            SetError("Gaborator analysis resulted in a negative number of bands.");
            return;
        }

        bandOffsets.resize(numBands);
        bandStepLog2s.resize(numBands);
        bandLengths.resize(numBands);
        bandFreqsHz.resize(numBands);
        size_t totalComplexCoefficients = 0;
        double coefficientDensity = 0.0;

        for (int i = 0; i < numBands; ++i)
        {
            int gbno = bandBegin + i;
            int stepLog2 = analyzer.band_step_log2(gbno);
            coefficientDensity += 1.0 / (double)(1ULL << stepLog2);
            double centerFreq = analyzer.bandpass_band_ff(gbno) * sampleRate;
            size_t len = (numFrames > 0) ? ((numFrames - 1) >> stepLog2) + 1 : 0;
            bandOffsets[i] = static_cast<uint32_t>(totalComplexCoefficients);
            bandStepLog2s[i] = stepLog2;
            bandLengths[i] = static_cast<uint32_t>(len);
            bandFreqsHz[i] = centerFreq;
            totalComplexCoefficients += len;
        }

        const int maxWidth = MAX_TEXTURE_SIZE;
        const int maxHeight = MAX_TEXTURE_SIZE;
        textureWidth = std::min((size_t)maxWidth, totalComplexCoefficients);
        textureHeight = (totalComplexCoefficients > 0) ? (totalComplexCoefficients + textureWidth - 1) / textureWidth : 0;

        if (textureHeight > maxHeight)
        {
            if (coefficientDensity > 1e-9)
            {
                size_t maxCoefficients = (size_t)maxWidth * maxHeight;
                double maxFrames = (double)maxCoefficients / coefficientDensity;
                double maxSeconds = maxFrames / sampleRate;

                std::stringstream ss;
                ss << "The maximum audio duration with these settings is " << std::fixed << std::setprecision(0) << maxSeconds << " seconds.";
                SetError(ss.str().c_str());
            }
            else
            {
                SetError("The audio file is too long.");
            }
            return;
        }

        size_t floatsPerPixel = 4;
        size_t dataFloatCount = (size_t)textureWidth * textureHeight * floatsPerPixel;
        data.assign(dataFloatCount, 0.0f);

        size_t floatsPerMapPixel = 2;
        size_t paddedMapFloatCount = (size_t)textureWidth * textureHeight * floatsPerMapPixel;
        inverseMap.assign(paddedMapFloatCount, 0.0f);

        size_t maxPixelIndex = (size_t)textureWidth * textureHeight;

        size_t floatsPerMetaPixel = 4;
        size_t metadataFloatCount = (size_t)numBands * floatsPerMetaPixel;
        metadata.resize(metadataFloatCount);

        for (int i = 0; i < numBands; ++i)
        {
            metadata[i * floatsPerMetaPixel + 0] = static_cast<float>(bandOffsets[i]);
            metadata[i * floatsPerMetaPixel + 1] = static_cast<float>(bandLengths[i]);
            metadata[i * floatsPerMetaPixel + 2] = static_cast<float>(bandStepLog2s[i]);
            metadata[i * floatsPerMetaPixel + 3] = bandFreqsHz[i];
        }

        for (int bandIdx = 0; bandIdx < numBands; ++bandIdx)
        {
            uint64_t timeStep = 1ULL << bandStepLog2s[bandIdx];
            for (uint32_t i = 0; i < bandLengths[bandIdx]; ++i)
            {
                size_t linearPixelIndex = bandOffsets[bandIdx] + i;
                inverseMap[linearPixelIndex * 2 + 0] = static_cast<float>(i * timeStep);
                inverseMap[linearPixelIndex * 2 + 1] = static_cast<float>(bandIdx);
            }
        }

        std::vector<gaborator::coefs<float>> allCoefs;
        allCoefs.reserve(channels);

        std::vector<std::vector<std::vector<float>>> previousPhases(channels);
        for (int ch = 0; ch < channels; ++ch)
        {
            previousPhases[ch].resize(numBands);
            for (int bandIdx = 0; bandIdx < numBands; ++bandIdx)
            {
                previousPhases[ch][bandIdx].resize(bandLengths[bandIdx], 0.0f);
            }
        }

        for (int ch = 0; ch < channels; ++ch)
        {
            allCoefs.emplace_back(analyzer);
            analyzer.analyze(audioChannels[ch].data(), 0, static_cast<int64_t>(numFrames), allCoefs.back());
            gaborator::process(
                [&](int b, int64_t t, std::complex<float> &coef)
                {
                    int bandIdx = b - bandBegin;
                    if (bandIdx < 0 || bandIdx >= numBands)
                        return;
                    int64_t tInBand = t >> bandStepLog2s[bandIdx];
                    if (tInBand < 0 || (size_t)tInBand >= bandLengths[bandIdx])
                        return;
                    size_t baseOffset = bandOffsets[bandIdx] + tInBand;
                    // Only write if within the clamped texture bounds
                    if (baseOffset >= maxPixelIndex)
                        return;

                    // Convert to magnitude and phase
                    float magnitude = std::abs(coef);
                    float phase = std::arg(coef);

                    // Unwrap phase: accumulate phase changes
                    float unwrappedPhase = phase;
                    if (tInBand > 0)
                    {
                        float prevPhase = previousPhases[ch][bandIdx][tInBand - 1];
                        float phaseDiff = phase - std::fmod(prevPhase, 2.0f * M_PI);

                        // Normalize phase difference to [-pi, pi]
                        while (phaseDiff > M_PI)
                            phaseDiff -= 2.0f * M_PI;
                        while (phaseDiff < -M_PI)
                            phaseDiff += 2.0f * M_PI;

                        unwrappedPhase = prevPhase + phaseDiff;
                    }
                    previousPhases[ch][bandIdx][tInBand] = unwrappedPhase;

                    size_t writeOffset = baseOffset * floatsPerPixel;
                    data[writeOffset + ch * 2 + 0] = magnitude;
                    data[writeOffset + ch * 2 + 1] = unwrappedPhase;
                },
                bandBegin, analyzer.bandpass_bands_end(), 0, numFrames, allCoefs[ch]);
        }
    }

    void OnOK()
    {
        Napi::Env env = Env();
        Napi::HandleScope scope(env);
        Napi::Object resultJs = Napi::Object::New(env);

        Napi::Float32Array dataJs = Napi::Float32Array::New(env, data.size());
        memcpy(dataJs.Data(), data.data(), data.size() * sizeof(float));
        resultJs.Set("data", dataJs);

        Napi::Float32Array inverseMapJs = Napi::Float32Array::New(env, inverseMap.size());
        memcpy(inverseMapJs.Data(), inverseMap.data(), inverseMap.size() * sizeof(float));
        resultJs.Set("inverseMap", inverseMapJs);

        Napi::Float32Array metadataJs = Napi::Float32Array::New(env, metadata.size());
        memcpy(metadataJs.Data(), metadata.data(), metadata.size() * sizeof(float));
        resultJs.Set("metadata", metadataJs);

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

        Napi::Float32Array bandFreqsHzJs = Napi::Float32Array::New(env, bandFreqsHz.size());
        memcpy(bandFreqsHzJs.Data(), bandFreqsHz.data(), bandFreqsHz.size() * sizeof(float));
        resultJs.Set("bandFreqsHz", bandFreqsHzJs);

        Napi::Uint32Array bandLengthsJs = Napi::Uint32Array::New(env, bandLengths.size());
        memcpy(bandLengthsJs.Data(), bandLengths.data(), bandLengths.size() * sizeof(uint32_t));
        resultJs.Set("bandLengths", bandLengthsJs);

        deferred.Resolve(resultJs);
    }

    void OnError(const Napi::Error &e)
    {
        deferred.Reject(e.Value());
    }

    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    std::vector<std::vector<float>> audioChannels;
    int channels;
    double sampleRate;
    int bandsPerOctave;
    double fminHz;

    // Results
    std::vector<float> data;
    std::vector<float> inverseMap;
    std::vector<float> metadata;
    int textureWidth;
    int textureHeight;
    size_t numFrames;
    int numBands;
    std::vector<uint32_t> bandOffsets;
    std::vector<int32_t> bandStepLog2s;
    std::vector<uint32_t> bandLengths;
    std::vector<float> bandFreqsHz;
};

Napi::Value AnalyzeAsync(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 4 || !info[0].IsArray() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsObject())
    {
        Napi::TypeError::New(env, "Expected: channelArrays (Array of Float32Arrays), channels (Number), sampleRate (Number), params (Object)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Array planarInput = info[0].As<Napi::Array>();
    int channels = info[1].As<Napi::Number>().Int32Value();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();
    Napi::Object paramsJs = info[3].As<Napi::Object>();

    if (!paramsJs.Has("bandsPerOctave") || !paramsJs.Get("bandsPerOctave").IsNumber())
    {
        Napi::TypeError::New(env, "params.bandsPerOctave is missing or not a number").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (!paramsJs.Has("minFreq") || !paramsJs.Get("minFreq").IsNumber())
    {
        Napi::TypeError::New(env, "params.minFreq is missing or not a number").ThrowAsJavaScriptException();
        return env.Null();
    }

    if (channels <= 0 || channels > 2)
    {
        Napi::TypeError::New(env, "Number of channels must be 1 or 2.").ThrowAsJavaScriptException();
        return env.Null();
    }

    AnalyzeWorker *worker = new AnalyzeWorker(env, planarInput, channels, sampleRate, paramsJs);
    worker->Queue();
    return worker->GetPromise();
}

class SynthesizeWorker : public Napi::AsyncWorker
{
public:
    SynthesizeWorker(Napi::Env env,
                     const Napi::Float32Array &inputDataJs,
                     const Napi::Object &analysisObj,
                     double sampleRate,
                     const Napi::Object &paramsJs,
                     bool normalize,
                     const Napi::Array &existingAudioJs,
                     int64_t startFrame,
                     int64_t endFrame,
                     int64_t startBand,
                     int64_t endBand)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), sampleRate(sampleRate), normalize(normalize),
          requestedStartFrame(startFrame), requestedEndFrame(endFrame), requestedStartBand(startBand), requestedEndBand(endBand)
    {
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

        // Copy existing audio if provided (for partial synthesis with crossfade)
        if (existingAudioJs.Length() > 0)
        {
            existingAudio.resize(existingAudioJs.Length());
            for (uint32_t i = 0; i < existingAudioJs.Length(); i++)
            {
                Napi::Float32Array channelJs = existingAudioJs.Get(i).As<Napi::Float32Array>();
                existingAudio[i].assign(channelJs.Data(), channelJs.Data() + channelJs.ElementLength());
            }
        }
    }

    ~SynthesizeWorker() {}

    void Execute()
    {
        DEBUG_LOG << "[C++] Execute() started" << std::endl << std::flush;
        DEBUG_LOG << "[C++] requestedStartFrame=" << requestedStartFrame << ", requestedEndFrame=" << requestedEndFrame << std::endl << std::flush;
        DEBUG_LOG << "[C++] requestedStartBand=" << requestedStartBand << ", requestedEndBand=" << requestedEndBand << std::endl << std::flush;
        DEBUG_LOG << "[C++] numFrames=" << numFrames << ", channels=" << channels << ", numBands=" << numBands << std::endl << std::flush;
        DEBUG_LOG << "[C++] existingAudio.size()=" << existingAudio.size() << std::endl << std::flush;

        double fminFrac = fminHz / sampleRate;
        gaborator::log_fq_scale scale(bandsPerOctave, fminFrac);
        gaborator::parameters params(scale, OVERLAP);
        params.phase = gaborator::coef_phase::global;
        gaborator::analyzer<float> analyzer(params);

        DEBUG_LOG << "[C++] Analyzer created" << std::endl << std::flush;

        int band_begin = analyzer.bandpass_bands_begin();
        int band_end = analyzer.bandpass_bands_end();

        DEBUG_LOG << "[C++] band_begin=" << band_begin << ", band_end=" << band_end << std::endl << std::flush;

        // Check if we're doing partial synthesis (have existing audio and frame range specified)
        bool isPartialSynthesis = !existingAudio.empty() && requestedStartFrame >= 0 && requestedEndFrame > requestedStartFrame;

        // Calculate synthesis support based on the bands that were modified
        int64_t synthesisSupportSamples;
        if (isPartialSynthesis && requestedStartBand >= 0 && requestedEndBand > requestedStartBand)
        {
            // Use band-specific support for only the modified bands
            double maxSupport = 0.0;
            int actualStartBand = std::max(0, static_cast<int>(requestedStartBand));
            int actualEndBand = std::min(numBands, static_cast<int>(requestedEndBand));
            for (int b = actualStartBand; b < actualEndBand; b++)
            {
                double support = analyzer.band_synthesis_support(b + band_begin);
                maxSupport = std::max(maxSupport, support);
            }
            synthesisSupportSamples = static_cast<int64_t>(std::ceil(maxSupport));
            DEBUG_LOG << "[C++] Band-specific support for bands " << actualStartBand << "-" << actualEndBand << ": " << synthesisSupportSamples << std::endl << std::flush;
        }
        else
        {
            // Use global maximum support
            synthesisSupportSamples = static_cast<int64_t>(std::ceil(analyzer.synthesis_support()));
        }

        // Cap synthesis support at 0.1 seconds
        int64_t maxSupportSamples = static_cast<int64_t>(sampleRate * 0.1);
        synthesisSupportSamples = std::min(synthesisSupportSamples, maxSupportSamples);
        DEBUG_LOG << "[C++] synthesisSupportSamples (capped at " << maxSupportSamples << "): " << synthesisSupportSamples << std::endl << std::flush;

        // Crossfade duration: 10ms
        int64_t crossfadeSamples = static_cast<int64_t>(sampleRate * 0.01);
        DEBUG_LOG << "[C++] crossfadeSamples: " << crossfadeSamples << std::endl << std::flush;

        int64_t synthStart, synthEnd;
        size_t floatsPerPixel = 4;

        if (isPartialSynthesis)
        {
            // Partial synthesis: synthesize just the dirty region with margin
            synthStart = std::max(int64_t(0), requestedStartFrame - synthesisSupportSamples);
            synthEnd = std::min(static_cast<int64_t>(numFrames), requestedEndFrame + synthesisSupportSamples);
        }
        else
        {
            // Full synthesis
            synthStart = 0;
            synthEnd = static_cast<int64_t>(numFrames);
        }

        DEBUG_LOG << "[C++] synthStart=" << synthStart << ", synthEnd=" << synthEnd << std::endl << std::flush;

        // Calculate fill range - for partial synthesis, only fill the time range we need
        // Add extra margin for the fill to ensure synthesis has all needed coefficients
        int64_t fillStart = 0;
        int64_t fillEnd = static_cast<int64_t>(numFrames);
        if (isPartialSynthesis)
        {
            // Use a generous margin for fill (2x synthesis support) to ensure all needed coefficients
            int64_t fillMargin = synthesisSupportSamples * 2;
            fillStart = std::max(int64_t(0), synthStart - fillMargin);
            fillEnd = std::min(static_cast<int64_t>(numFrames), synthEnd + fillMargin);
            DEBUG_LOG << "[C++] Partial fill range: " << fillStart << " to " << fillEnd << " (vs full: 0 to " << numFrames << ")" << std::endl << std::flush;
        }

        // Fill and synthesize
        std::vector<std::vector<float>> synthesizedBuffers(channels);

        for (int ch = 0; ch < channels; ++ch)
        {
            DEBUG_LOG << "[C++] Processing channel " << ch << std::endl << std::flush;
            gaborator::coefs<float> channelCoefs(analyzer);

            // Fill coefficients for the required range
            gaborator::fill(
                [&](int b, int64_t t, std::complex<float> &coef)
                {
                    int band_idx = b - band_begin;
                    if (band_idx < 0 || band_idx >= numBands)
                    {
                        coef = {0.0f, 0.0f};
                        return;
                    }
                    int64_t t_in_band = t >> bandStepLog2s[band_idx];
                    if (t_in_band < 0 || (size_t)t_in_band >= (size_t)bandLengths[band_idx])
                    {
                        coef = {0.0f, 0.0f};
                        return;
                    }
                    size_t base_offset = bandOffsets[band_idx] + t_in_band;
                    size_t readOffset = base_offset * floatsPerPixel;

                    size_t maxReadIndex = readOffset + ch * 2 + 1;
                    if (maxReadIndex >= inputData.size())
                    {
                        coef = {0.0f, 0.0f};
                        return;
                    }

                    float magnitude = inputData[readOffset + ch * 2 + 0];
                    float unwrappedPhase = inputData[readOffset + ch * 2 + 1];
                    float real = magnitude * std::cos(unwrappedPhase);
                    float imag = magnitude * std::sin(unwrappedPhase);
                    coef.real(real);
                    coef.imag(imag);
                },
                band_begin, band_end, fillStart, fillEnd, channelCoefs);

            // Synthesize the required range
            size_t synthLength = static_cast<size_t>(synthEnd - synthStart);
            synthesizedBuffers[ch].resize(synthLength);
            analyzer.synthesize(channelCoefs, synthStart, synthEnd, synthesizedBuffers[ch].data());
            DEBUG_LOG << "[C++] Channel " << ch << " - synthesized " << synthLength << " samples" << std::endl << std::flush;
        }

        // Prepare output
        audioChannels.resize(channels);

        if (isPartialSynthesis)
        {
            // Partial synthesis: crossfade-splice into existing audio
            DEBUG_LOG << "[C++] Doing partial synthesis with crossfade splice" << std::endl << std::flush;

            for (int ch = 0; ch < channels; ++ch)
            {
                // Start with copy of existing audio
                audioChannels[ch] = existingAudio[ch];

                // Apply crossfade at boundaries
                int64_t fadeInStart = synthStart;
                int64_t fadeInEnd = std::min(synthStart + crossfadeSamples, synthEnd);
                int64_t fadeOutStart = std::max(synthEnd - crossfadeSamples, synthStart);
                int64_t fadeOutEnd = synthEnd;

                for (int64_t i = synthStart; i < synthEnd; ++i)
                {
                    size_t synthIdx = static_cast<size_t>(i - synthStart);
                    float newSample = synthesizedBuffers[ch][synthIdx];
                    float oldSample = existingAudio[ch][i];

                    float blend = 1.0f; // Default: use new sample fully

                    // Fade-in at start
                    if (i >= fadeInStart && i < fadeInEnd && fadeInEnd > fadeInStart)
                    {
                        float fadeProgress = static_cast<float>(i - fadeInStart) / static_cast<float>(fadeInEnd - fadeInStart);
                        blend = fadeProgress;
                    }
                    // Fade-out at end
                    else if (i >= fadeOutStart && i < fadeOutEnd && fadeOutEnd > fadeOutStart)
                    {
                        float fadeProgress = static_cast<float>(i - fadeOutStart) / static_cast<float>(fadeOutEnd - fadeOutStart);
                        blend = 1.0f - fadeProgress;
                    }

                    // Crossfade blend
                    audioChannels[ch][i] = oldSample * (1.0f - blend) + newSample * blend;
                }
                DEBUG_LOG << "[C++] Channel " << ch << " - crossfade splice complete" << std::endl << std::flush;
            }
        }
        else
        {
            // Full synthesis: just use synthesized buffers directly
            for (int ch = 0; ch < channels; ++ch)
            {
                audioChannels[ch] = std::move(synthesizedBuffers[ch]);
            }

            // Apply normalization for full synthesis
            if (normalize)
            {
                float peak_value = 0.0f;
                for (const auto &channel_data : audioChannels)
                {
                    for (float sample : channel_data)
                    {
                        peak_value = std::max(peak_value, std::abs(sample));
                    }
                }
                if (peak_value > 0.0f)
                {
                    float normalization_factor = 1.0f / peak_value;
                    for (auto &channel_data : audioChannels)
                    {
                        for (float &sample : channel_data)
                        {
                            sample *= normalization_factor;
                        }
                    }
                    DEBUG_LOG << "[C++] Normalized with factor: " << normalization_factor << std::endl << std::flush;
                }
            }
        }

        DEBUG_LOG << "[C++] Execute() complete" << std::endl << std::flush;
    }

    void OnOK()
    {
        Napi::Env env = Env();
        Napi::HandleScope scope(env);

        Napi::Object result = Napi::Object::New(env);
        Napi::Array outputChannels = Napi::Array::New(env, channels);
        for (int ch = 0; ch < channels; ++ch)
        {
            size_t outputLength = audioChannels[ch].size();
            Napi::Float32Array channelBuffer = Napi::Float32Array::New(env, outputLength);
            memcpy(channelBuffer.Data(), audioChannels[ch].data(), outputLength * sizeof(float));
            outputChannels[ch] = channelBuffer;
        }
        result.Set("channels", outputChannels);
        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e)
    {
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
    int64_t requestedStartFrame;
    int64_t requestedEndFrame;
    int64_t requestedStartBand;
    int64_t requestedEndBand;
    std::vector<std::vector<float>> existingAudio;

    // Results
    std::vector<std::vector<float>> audioChannels;
};

Napi::Value SynthesizeAsync(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 6 || !info[0].IsTypedArray() || !info[1].IsObject() || !info[2].IsNumber() || !info[3].IsObject() || !info[4].IsBoolean() || !info[5].IsArray())
    {
        Napi::TypeError::New(env, "Expected: data (TypedArray), analysisObject (Object), sampleRate (Number), params (Object), normalize (Boolean), existingAudio (Array), [startFrame], [endFrame], [startBand], [endBand]").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array inputDataJs = info[0].As<Napi::Float32Array>();
    Napi::Object analysisObj = info[1].As<Napi::Object>();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();
    Napi::Object paramsJs = info[3].As<Napi::Object>();
    bool normalize = info[4].As<Napi::Boolean>().Value();
    Napi::Array existingAudioJs = info[5].As<Napi::Array>();

    // Optional start/end frame and band for partial synthesis (-1 means full range)
    int64_t startFrame = -1;
    int64_t endFrame = -1;
    int64_t startBand = -1;
    int64_t endBand = -1;

    if (info.Length() > 6 && info[6].IsNumber())
    {
        startFrame = info[6].As<Napi::Number>().Int64Value();
    }
    if (info.Length() > 7 && info[7].IsNumber())
    {
        endFrame = info[7].As<Napi::Number>().Int64Value();
    }
    if (info.Length() > 8 && info[8].IsNumber())
    {
        startBand = info[8].As<Napi::Number>().Int64Value();
    }
    if (info.Length() > 9 && info[9].IsNumber())
    {
        endBand = info[9].As<Napi::Number>().Int64Value();
    }

    if (!paramsJs.Has("bandsPerOctave") || !paramsJs.Get("bandsPerOctave").IsNumber())
    {
        Napi::TypeError::New(env, "params.bandsPerOctave is missing or not a number").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (!paramsJs.Has("minFreq") || !paramsJs.Get("minFreq").IsNumber())
    {
        Napi::TypeError::New(env, "params.minFreq is missing or not a number").ThrowAsJavaScriptException();
        return env.Null();
    }

    SynthesizeWorker *worker = new SynthesizeWorker(env, inputDataJs, analysisObj, sampleRate, paramsJs, normalize, existingAudioJs, startFrame, endFrame, startBand, endBand);
    worker->Queue();
    return worker->GetPromise();
}

// ─── HPSS helpers ────────────────────────────────────────────────────────────

// O(n) median via nth_element; modifies v in-place
static float medianInPlace(std::vector<float> &v)
{
    if (v.empty())
        return 0.0f;
    size_t mid = v.size() / 2;
    std::nth_element(v.begin(), v.begin() + mid, v.end());
    if (v.size() % 2 == 1)
        return v[mid];
    float hi = v[mid];
    std::nth_element(v.begin(), v.begin() + mid - 1, v.end());
    return (v[mid - 1] + hi) * 0.5f;
}

// Sliding-window 1-D median filter along the time axis for a single band.
// Boundary condition: clamp (reflect-zero).
static std::vector<float> timeMedianFilter(const std::vector<float> &band, int kernel)
{
    int L = (int)band.size();
    int half = kernel / 2;
    std::vector<float> result(L);
    std::vector<float> window;
    window.reserve(kernel);
    for (int t = 0; t < L; ++t)
    {
        window.clear();
        for (int dt = -half; dt <= half; ++dt)
        {
            int idx = std::max(0, std::min(L - 1, t + dt));
            window.push_back(band[idx]);
        }
        result[t] = medianInPlace(window);
    }
    return result;
}

// Median filter across adjacent frequency bands at each time position.
// Adjacent bands are aligned by normalised time (0-1) and nearest-sample lookup.
static std::vector<std::vector<float>> freqMedianFilter(
    const std::vector<std::vector<float>> &mags,
    const std::vector<uint32_t> &bandLengths,
    int numBands, int kernel)
{
    int half = kernel / 2;
    std::vector<std::vector<float>> P(numBands);
    std::vector<float> window;
    window.reserve(kernel);

    for (int b = 0; b < numBands; ++b)
    {
        int L = (int)bandLengths[b];
        P[b].resize(L);
        for (int t = 0; t < L; ++t)
        {
            float normTime = (L > 1) ? (float)t / (float)(L - 1) : 0.0f;
            window.clear();
            for (int db = -half; db <= half; ++db)
            {
                int nb = b + db;
                if (nb < 0 || nb >= numBands)
                    continue;
                int nbL = (int)bandLengths[nb];
                int nbT = (nbL > 1)
                              ? std::min((int)std::round(normTime * (float)(nbL - 1)), nbL - 1)
                              : 0;
                window.push_back(mags[nb][nbT]);
            }
            P[b][t] = medianInPlace(window);
        }
    }
    return P;
}

// ─── HpssWorker ──────────────────────────────────────────────────────────────

class HpssWorker : public Napi::AsyncWorker
{
public:
    HpssWorker(Napi::Env env,
               Napi::Float32Array packedDataJs,
               Napi::Object metaJs,
               int kernelH, int kernelV)
        : Napi::AsyncWorker(env),
          deferred(Napi::Promise::Deferred::New(env)),
          kernelH(kernelH), kernelV(kernelV)
    {
        packedData.assign(packedDataJs.Data(),
                          packedDataJs.Data() + packedDataJs.ElementLength());

        numBands    = metaJs.Get("numBands").As<Napi::Number>().Int32Value();
        numChannels = metaJs.Get("numChannels").As<Napi::Number>().Int32Value();

        Napi::Uint32Array bo = metaJs.Get("bandOffsets").As<Napi::Uint32Array>();
        bandOffsets.assign(bo.Data(), bo.Data() + bo.ElementLength());

        Napi::Uint32Array bl = metaJs.Get("bandLengths").As<Napi::Uint32Array>();
        bandLengths.assign(bl.Data(), bl.Data() + bl.ElementLength());
    }

    Napi::Promise GetPromise() { return deferred.Promise(); }

    void Execute() override
    {
        const int floatsPerPixel = 4;
        // Start with full copies — phase channels are preserved untouched
        harmonicData   = packedData;
        percussiveData = packedData;

        const float eps = 1e-10f;

        for (int ch = 0; ch < numChannels; ++ch)
        {
            int magOff = ch * 2; // 0 for left channel, 2 for right

            // Extract magnitude per band
            std::vector<std::vector<float>> mags(numBands);
            for (int b = 0; b < numBands; ++b)
            {
                int L = (int)bandLengths[b];
                mags[b].resize(L);
                for (int t = 0; t < L; ++t)
                {
                    size_t fi = ((size_t)bandOffsets[b] + t) * floatsPerPixel + magOff;
                    mags[b][t] = packedData[fi];
                }
            }

            // H: time-axis median → captures content stable over time (harmonic)
            std::vector<std::vector<float>> H(numBands);
            for (int b = 0; b < numBands; ++b)
                H[b] = timeMedianFilter(mags[b], kernelH);

            // P: frequency-axis median → captures broadband transients (percussive)
            std::vector<std::vector<float>> P =
                freqMedianFilter(mags, bandLengths, numBands, kernelV);

            // Wiener soft masks applied to magnitude channels only
            for (int b = 0; b < numBands; ++b)
            {
                int L = (int)bandLengths[b];
                for (int t = 0; t < L; ++t)
                {
                    size_t fi = ((size_t)bandOffsets[b] + t) * floatsPerPixel + magOff;
                    float h = H[b][t], p = P[b][t];
                    float h2 = h * h, p2 = p * p, denom = h2 + p2 + eps;
                    harmonicData[fi]   = packedData[fi] * (h2 / denom);
                    percussiveData[fi] = packedData[fi] * (p2 / denom);
                }
            }
        }
    }

    void OnOK() override
    {
        Napi::Env env = Env();
        Napi::Object result = Napi::Object::New(env);

        Napi::Float32Array hJs = Napi::Float32Array::New(env, harmonicData.size());
        memcpy(hJs.Data(), harmonicData.data(), harmonicData.size() * sizeof(float));
        result.Set("harmonic", hJs);

        Napi::Float32Array pJs = Napi::Float32Array::New(env, percussiveData.size());
        memcpy(pJs.Data(), percussiveData.data(), percussiveData.size() * sizeof(float));
        result.Set("percussive", pJs);

        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }

private:
    Napi::Promise::Deferred deferred;
    std::vector<float>    packedData, harmonicData, percussiveData;
    std::vector<uint32_t> bandOffsets, bandLengths;
    int numBands, numChannels, kernelH, kernelV;
};

Napi::Value HpssAsync(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsObject())
    {
        Napi::TypeError::New(env,
            "Expected (Float32Array packedData, Object meta[, number kernelH, number kernelV])")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    int kernelH = (info.Length() > 2 && info[2].IsNumber()) ? info[2].As<Napi::Number>().Int32Value() : 31;
    int kernelV = (info.Length() > 3 && info[3].IsNumber()) ? info[3].As<Napi::Number>().Int32Value() : 31;

    auto *worker = new HpssWorker(env,
        info[0].As<Napi::Float32Array>(),
        info[1].As<Napi::Object>(),
        kernelH, kernelV);
    auto promise = worker->GetPromise();
    worker->Queue();
    return promise;
}

// ─────────────────────────────────────────────────────────────────────────────

Napi::Object init(Napi::Env env, Napi::Object exports)
{
    exports.Set("analyze", Napi::Function::New(env, AnalyzeAsync));
    exports.Set("synthesize", Napi::Function::New(env, SynthesizeAsync));
    exports.Set("hpss", Napi::Function::New(env, HpssAsync));
    return exports;
}

NODE_API_MODULE(gaborator_addon, init);