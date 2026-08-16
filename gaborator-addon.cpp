// addon.cpp

#include <napi.h>
#include <vector>
#include <complex>
#include <numeric>
#include <cmath>
#include <algorithm>
#include <deque>
#include <string>   // For std::string
#include <sstream>  // For std::stringstream
#include <iomanip>  // For std::fixed, std::setprecision
#include <iostream> // For std::cerr
#include <fstream>  // For file logging
#include <cstdint>
#include "gaborator/gaborator.h"

#ifdef _WIN32
// NOMINMAX keeps windows.h from macro-defining min/max over the std:: calls
// throughout this file.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <dxgi.h>
#endif

#define OVERLAP 0.7
#define MAX_TEXTURE_SIZE 8192
// Packed coefficients per input frame at the densest resolution the app offers
// (12 bands/octave). Must stay at or above every resolution's own density, or a
// file that opens at one resolution fails to re-analyse at another.
#define MAX_COEFFICIENT_DENSITY 4.79

// Debug logging to file
static std::ofstream &getDebugLog()
{
    static std::ofstream debugLog("/tmp/gaborator_debug.log", std::ios::out | std::ios::app);
    return debugLog;
}

#define DEBUG_LOG getDebugLog()

// True-peak ceiling at -2 dBTP. The limiters bound the inter-sample
// (reconstructed) peak, not just the sample peak, so playback resampling or the
// DAC cannot clip overshoots hidden between samples. The headroom below 0 dBFS
// exceeds the -1 dBTP streaming standard because near-Nyquist content is the
// hardest case for finite-rate true-peak detection and the gain-envelope
// smoothing shifts the peak reduction slightly; the margin covers both.
static constexpr float LIMITER_CEILING = 0.794f;

// Channel-linked per-sample true peak. Detection follows ITU-R BS.1770:
// oversample with a polyphase windowed-sinc FIR and take the peak of the
// reconstructed signal. Both the oversampling factor and the FIR length must be
// generous or the detector under-reads near-Nyquist inter-sample peaks (by
// ~1 dB at 4x/short-FIR) and a limiter fed by it lets real peaks slip over
// 0 dBFS, which clips on playback. Below 0.25 the sample peak stands in for the
// reconstruction; nothing that quiet can overshoot the ceiling.
static std::vector<float> truePeakPerSample(const std::vector<std::vector<float>> &channels)
{
    constexpr int OS = 16;  // oversampling factor for true-peak detection
    constexpr int HT = 16;  // half kernel width; the interpolation FIR has 2*HT taps per phase
    constexpr float kPi = 3.14159265358979323846f;
    const int channelCount = static_cast<int>(channels.size());
    const size_t blockLen = channels.empty() ? 0 : channels[0].size();
    std::vector<float> truePeak(blockLen, 0.0f);

    // Polyphase windowed-sinc kernels that reconstruct the signal at the fractional
    // sample positions between each pair of samples.
    float kernels[OS][2 * HT];
    for (int ph = 0; ph < OS; ++ph)
    {
        const float d = static_cast<float>(ph) / OS;
        for (int t = 0; t < 2 * HT; ++t)
        {
            const float xpos = static_cast<float>(t - HT + 1) - d;
            const float sinc = std::abs(xpos) < 1e-6f ? 1.0f : std::sin(kPi * xpos) / (kPi * xpos);
            const float win = 0.5f + 0.5f * std::cos(kPi * xpos / HT);
            kernels[ph][t] = sinc * win;
        }
    }

    for (size_t i = 0; i < blockLen; ++i)
    {
        float peak = 0.0f;
        const bool interior = i >= static_cast<size_t>(HT) && i + HT < blockLen;
        for (int ch = 0; ch < channelCount; ++ch)
        {
            const float here = std::abs(channels[ch][i]);
            float chPeak = here;
            const float next = (i + 1 < blockLen) ? std::abs(channels[ch][i + 1]) : 0.0f;
            // Only reconstruct between samples that are loud enough to overshoot.
            if (interior && std::max(here, next) > 0.25f)
            {
                for (int ph = 1; ph < OS; ++ph)
                {
                    float acc = 0.0f;
                    for (int t = 0; t < 2 * HT; ++t)
                        acc += channels[ch][i + t - HT + 1] * kernels[ph][t];
                    chPeak = std::max(chPeak, std::abs(acc));
                }
            }
            peak = std::max(peak, chPeak);
        }
        truePeak[i] = peak;
    }
    return truePeak;
}

// Shapes a per-sample required-gain curve so it stays smooth without ever
// rising above the requirement at a peak: instant attack (drop to each new
// low), hold for holdMs so a whole low-frequency cycle is scaled by a constant
// gain (no bass distortion), linear recovery over releaseMs, then three forward
// box blurs (running averages, O(n) each). The forward window biases the
// smoothing earlier in time, so the gain is already reduced before each peak
// (the look-ahead attack). The hold keeps the gain floor flat across the blur
// window at every peak, so averaging can never raise it back up — peaks stay
// caught, no overshoot. Three passes make the curve smooth (no slope kinks), so
// multiplying audio by it adds no clicks.
static void smoothLimiterGain(std::vector<float> &gainEnv, double sampleRate, float holdMs, float releaseMs)
{
    const size_t blockLen = gainEnv.size();
    if (!blockLen)
        return;

    const float releaseStep = 1.0f / std::max(1.0f, static_cast<float>(sampleRate) * releaseMs * 0.001f);
    const int holdSamples = static_cast<int>(std::max(0.0f, static_cast<float>(sampleRate) * holdMs * 0.001f));

    float env = gainEnv[0];
    int hold = 0;
    for (size_t i = 0; i < blockLen; ++i)
    {
        const float required = gainEnv[i];
        if (required <= env)
        {
            env = required;
            hold = holdSamples;
        }
        else if (hold > 0)
        {
            --hold;
        }
        else
        {
            env = std::min(required, env + releaseStep);
        }
        gainEnv[i] = env;
    }

    const int boxW = std::max(1, static_cast<int>(std::lround(static_cast<double>(sampleRate) * 0.0007)));
    std::vector<float> tmp(blockLen);
    for (int pass = 0; pass < 3; ++pass)
    {
        double sum = 0.0;
        int count = 0;
        for (int k = 0; k < boxW && static_cast<size_t>(k) < blockLen; ++k, ++count)
            sum += gainEnv[k];
        for (size_t i = 0; i < blockLen; ++i)
        {
            tmp[i] = static_cast<float>(sum / count);
            sum -= gainEnv[i];
            --count;
            const size_t add = i + static_cast<size_t>(boxW);
            if (add < blockLen)
            {
                sum += gainEnv[add];
                ++count;
            }
        }
        gainEnv.swap(tmp);
    }
}

// Sliding maximum over a centred window of +/- halfWidth samples, O(n) via a
// monotonic deque of indices.
static std::vector<float> slidingMax(const std::vector<float> &v, int halfWidth)
{
    const int64_t n = static_cast<int64_t>(v.size());
    std::vector<float> out(v.size(), 0.0f);
    std::deque<int64_t> idx;
    for (int64_t r = 0; r < n + halfWidth; ++r)
    {
        if (r < n)
        {
            while (!idx.empty() && v[static_cast<size_t>(idx.back())] <= v[static_cast<size_t>(r)])
                idx.pop_back();
            idx.push_back(r);
        }
        const int64_t c = r - halfWidth;
        if (c < 0 || c >= n)
            continue;
        while (idx.front() < c - halfWidth)
            idx.pop_front();
        out[static_cast<size_t>(c)] = v[static_cast<size_t>(idx.front())];
    }
    return out;
}

// Look-ahead true-peak brickwall limiter: the gain needed to bring the
// channel-linked inter-sample peak down to the ceiling, shaped by
// smoothLimiterGain, applied to every channel. All channels share one gain
// curve to preserve the stereo image.
static void applyLookaheadLimiter(std::vector<std::vector<float>> &channels, double sampleRate,
                                  float holdMs = 40.0f, float releaseMs = 200.0f,
                                  std::vector<float> *outGain = nullptr)
{
    if (channels.empty() || channels[0].empty())
        return;

    const std::vector<float> truePeak = truePeakPerSample(channels);
    const size_t blockLen = channels[0].size();
    std::vector<float> gainEnv(blockLen, 1.0f);
    for (size_t i = 0; i < blockLen; ++i)
        if (truePeak[i] > LIMITER_CEILING)
            gainEnv[i] = LIMITER_CEILING / truePeak[i];

    smoothLimiterGain(gainEnv, sampleRate, holdMs, releaseMs);

    for (size_t i = 0; i < blockLen; ++i)
        for (int ch = 0; ch < static_cast<int>(channels.size()); ++ch)
            channels[ch][i] *= gainEnv[i];

    // Hand back the final per-sample gain (1.0 = no reduction) for the meter.
    if (outGain)
        *outGain = std::move(gainEnv);
}

/**
 * Phase on the branch the packed format stores: congruent to `phase` mod 2pi and
 * within pi of the previous coefficient's stored phase. Every writer of a packed
 * phase must go through this, or the stored sequence stops being unwrapped and
 * the transform reads the wrong instantaneous frequency.
 */
static inline float unwrapForward(float phase, float prevUnwrapped)
{
    const float twoPi = 2.0f * (float)M_PI;
    float diff = phase - std::fmod(prevUnwrapped, twoPi);
    diff -= twoPi * std::round(diff / twoPi);
    return prevUnwrapped + diff;
}

/**
 * A view of a packed FBO buffer: 4 floats per coefficient
 * ([magL, phaseL, magR, phaseR]), bands laid back to back at bandOffsets with
 * bandLengths entries each, band b holding the sample time t at t >> stepLog2.
 */
struct PackedCoefs
{
    const float *data = nullptr;
    size_t len = 0;
    const uint32_t *bandOffsets = nullptr;
    const uint32_t *bandLengths = nullptr;
    const int32_t *bandStepLog2s = nullptr;
    int numBands = 0;
};

/**
 * Reads one channel out of the packed buffer into `out` over [fillStart,
 * fillEnd). Bands outside the packed layout, and times outside a band's stored
 * range, read as silence.
 */
static void fillCoefsFromPacked(const PackedCoefs &src, int channel, int bandBegin, int bandEnd,
                                int64_t fillStart, int64_t fillEnd, gaborator::coefs<float> &out)
{
    gaborator::fill(
        [&](int b, int64_t t, std::complex<float> &coef)
        {
            const int bi = b - bandBegin;
            if (bi < 0 || bi >= src.numBands)
            {
                coef = {0.0f, 0.0f};
                return;
            }
            const int64_t k = t >> src.bandStepLog2s[bi];
            if (k < 0 || (size_t)k >= (size_t)src.bandLengths[bi])
            {
                coef = {0.0f, 0.0f};
                return;
            }
            const size_t off = ((size_t)src.bandOffsets[bi] + (size_t)k) * 4 + (size_t)channel * 2;
            if (off + 1 >= src.len)
            {
                coef = {0.0f, 0.0f};
                return;
            }
            const float mag = src.data[off];
            const float ph = src.data[off + 1];
            coef.real(mag * std::cos(ph));
            coef.imag(mag * std::sin(ph));
        },
        bandBegin, bandEnd, fillStart, fillEnd, out);
}

/**
 * Crossfades a block synthesized over [synthStart, synthEnd) into `dest`, which
 * already holds `existing`. 10 ms ramps at each seam, skipped where the seam is
 * a file boundary — there is no surrounding audio to fade against there, and
 * fading would leak the unmodified original through.
 */
static void crossfadeSpliceInto(std::vector<float> &dest, const float *existing,
                                const std::vector<float> &synth, int64_t synthStart, int64_t synthEnd,
                                int64_t numFrames, int64_t crossfadeSamples)
{
    const int64_t fadeInStart = synthStart;
    const int64_t fadeInEnd = (synthStart == 0) ? synthStart : std::min(synthStart + crossfadeSamples, synthEnd);
    const int64_t fadeOutEnd = synthEnd;
    const int64_t fadeOutStart = (synthEnd == numFrames) ? synthEnd : std::max(synthEnd - crossfadeSamples, synthStart);

    for (int64_t i = synthStart; i < synthEnd; ++i)
    {
        const float newSample = synth[(size_t)(i - synthStart)];
        const float oldSample = existing[i];

        float blend = 1.0f;
        if (i >= fadeInStart && i < fadeInEnd && fadeInEnd > fadeInStart)
            blend = (float)(i - fadeInStart) / (float)(fadeInEnd - fadeInStart);
        else if (i >= fadeOutStart && i < fadeOutEnd && fadeOutEnd > fadeOutStart)
            blend = 1.0f - (float)(i - fadeOutStart) / (float)(fadeOutEnd - fadeOutStart);

        dest[(size_t)i] = oldSample * (1.0f - blend) + newSample * blend;
    }
}

class AnalyzeWorker : public Napi::AsyncWorker
{
public:
    AnalyzeWorker(Napi::Env env, const Napi::Array &planarInput, int channels, double sampleRate, const Napi::Object &paramsJs)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), channels(channels), sampleRate(sampleRate)
    {
        size_t length = planarInput.Get(0u).As<Napi::Float32Array>().ElementLength();
        // Reference the channel buffers and read them by pointer on the worker
        // thread rather than copying them into vectors on the main thread.
        audioRefs.reserve(channels);
        audioChannels.reserve(channels);
        for (int ch = 0; ch < channels; ++ch)
        {
            Napi::Float32Array channelData = planarInput.Get(static_cast<uint32_t>(ch)).As<Napi::Float32Array>();
            audioRefs.push_back(Napi::Reference<Napi::Float32Array>::New(channelData, 1));
            audioChannels.push_back(channelData.Data());
        }
        numFrames = length;
        bandsPerOctave = paramsJs.Get("bandsPerOctave").As<Napi::Number>().Int32Value();
        fminHz = paramsJs.Get("minFreq").As<Napi::Number>().DoubleValue();
        if (paramsJs.Has("maxCoefficients") && paramsJs.Get("maxCoefficients").IsNumber())
        {
            double v = paramsJs.Get("maxCoefficients").As<Napi::Number>().DoubleValue();
            if (v > 0)
                maxCoefficientBudget = (size_t)v;
        }
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

        for (int i = 0; i < numBands; ++i)
        {
            int gbno = bandBegin + i;
            int stepLog2 = analyzer.band_step_log2(gbno);
            double centerFreq = analyzer.bandpass_band_ff(gbno) * sampleRate;
            size_t len = (numFrames > 0) ? ((numFrames - 1) >> stepLog2) + 1 : 0;
            bandOffsets[i] = static_cast<uint32_t>(totalComplexCoefficients);
            bandStepLog2s[i] = stepLog2;
            bandLengths[i] = static_cast<uint32_t>(len);
            bandFreqsHz[i] = centerFreq;
            totalComplexCoefficients += len;
        }

        // The coefficient cap is the texture dimension limit or the caller's
        // GPU-memory budget, whichever is smaller. Checked before any
        // allocation so an oversized file fails with a clear message instead
        // of exhausting memory.
        size_t maxCoefficients = (size_t)MAX_TEXTURE_SIZE * MAX_TEXTURE_SIZE;
        maxCoefficients = std::min(maxCoefficients, maxCoefficientBudget);

        double worstCaseCoefficients = (double)numFrames * MAX_COEFFICIENT_DENSITY;
        if (worstCaseCoefficients > (double)maxCoefficients || totalComplexCoefficients > maxCoefficients)
        {
            double maxSeconds = (double)maxCoefficients / MAX_COEFFICIENT_DENSITY / sampleRate;

            std::stringstream ss;
            ss << "The maximum audio duration is " << std::fixed << std::setprecision(0) << maxSeconds << " seconds.";
            SetError(ss.str().c_str());
            return;
        }

        textureWidth = std::min((size_t)MAX_TEXTURE_SIZE, totalComplexCoefficients);
        textureHeight = (totalComplexCoefficients > 0) ? (totalComplexCoefficients + textureWidth - 1) / textureWidth : 0;

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
            analyzer.analyze(audioChannels[ch], 0, static_cast<int64_t>(numFrames), allCoefs.back());
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

                    // Accumulate total stored magnitude energy (sum of squares
                    // over every stored coefficient, all bands and channels) so
                    // the renderer can derive a single IR-normalization scalar.
                    magnitudeEnergy += (double)magnitude * (double)magnitude;

                    // Unwrap phase: accumulate phase changes
                    float unwrappedPhase = phase;
                    if (tInBand > 0)
                        unwrappedPhase = unwrapForward(phase, previousPhases[ch][bandIdx][tInBand - 1]);
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
        resultJs.Set("magnitudeEnergy", Napi::Number::New(env, magnitudeEnergy));

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
    std::vector<Napi::Reference<Napi::Float32Array>> audioRefs;
    std::vector<const float *> audioChannels;
    int channels;
    double sampleRate;
    int bandsPerOctave;
    double fminHz;
    // Caller-supplied coefficient budget from the shared GPU-memory pool;
    // SIZE_MAX means no budget was passed and only the texture cap applies.
    size_t maxCoefficientBudget = SIZE_MAX;

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
    double magnitudeEnergy = 0.0;
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

// ─── Onset detection ─────────────────────────────────────────────────────────

// Onsets are detected straight from packed constant-Q coefficients. The
// detection function is a SuperFlux-style spectral flux (Böck & Widmer 2013)
// over log-compressed, per-band adaptively whitened magnitudes (Stowell &
// Plumbley), plus a complex-domain phase-prediction term (Bello/Duxbury) that
// catches soft tonal attacks a magnitude flux misses. Whitening equalizes quiet
// and loud passages; the max filter over neighbouring bands stops vibrato and
// pitch glides — which painting modulation produces constantly — from reading
// as new events.
//
// Peak picking is deliberately permissive and no threshold is applied here:
// every peak is returned with a continuous salience, and the UI's sensitivity
// control decides which ones count. Each accepted peak is then moved onto the
// energy ridge and refined to sub-bin precision, because a transform that
// re-anchors phase at an onset displaces the transient by
// (pitchRatio − 1) × the timing error.

struct OnsetBandLayout
{
    int numBands = 0;
    int numChannels = 1;
    const uint32_t *bandOffsets = nullptr;
    const uint32_t *bandLengths = nullptr;
    const int32_t *bandStepLog2s = nullptr;
};

struct DetectedOnset
{
    double timeSec;
    float salience;
};

/**
 * A patch laid over the packed buffer, so a detection can read coefficients a
 * commit has recomputed but not yet written back. Band b's coefficients
 * [k0[b], k0[b] + count[b]) come from `pixels` at pixelBase[b] instead of from
 * the packed data; everything else reads through.
 */
struct OnsetPatchOverlay
{
    const int64_t *k0 = nullptr;
    const int64_t *count = nullptr;
    const size_t *pixelBase = nullptr;
    const float *pixels = nullptr;
    size_t pixelFloats = 0;
};

// Time resolution of the detection function.
static constexpr double ONSET_BIN_SEC = 0.0005;
// Magnitude compression applied before whitening: log1p(gamma * mag).
static constexpr float ONSET_LOG_GAMMA = 20.0f;
// Decay time constant of the per-band running peak used for whitening.
static constexpr double ONSET_WHITEN_TAU_SEC = 2.0;
static constexpr float ONSET_WHITEN_FLOOR = 1e-4f;
// Floor of the same running peak as a share of the band's own loudest moment,
// so that quiet enough content in a band is left quiet instead of being lifted
// to the same footing as that band's real material.
static constexpr float ONSET_WHITEN_FLOOR_RATIO = 0.05f;
// Bands either side of the current one included in the SuperFlux max filter —
// a semitone of vibrato at the app's default 36 bands per octave.
static constexpr int ONSET_MAX_FILTER_BANDS = 3;
// Weight of the complex-domain term relative to the flux term.
static constexpr float ONSET_COMPLEX_WEIGHT = 0.5f;
// Half-width of the window a peak must dominate.
static constexpr double ONSET_PEAK_WINDOW_SEC = 0.015;
// Window the local mean is taken over, asymmetric so a peak is judged mostly
// against what preceded it.
static constexpr double ONSET_MEAN_PRE_SEC = 0.080;
static constexpr double ONSET_MEAN_POST_SEC = 0.030;
static constexpr float ONSET_THRESHOLD_RATIO = 1.5f;
static constexpr double ONSET_MIN_GAP_SEC = 0.030;
// How far past a detection-function peak the energy ridge is searched for; flux
// peaks on the rising edge, ahead of the ridge centre.
static constexpr double ONSET_RIDGE_SEARCH_SEC = 0.010;
// Fraction of the ridge window's peak energy that counts as having arrived.
static constexpr double ONSET_RIDGE_ARRIVAL = 0.95;
// Half-width of the box the ridge energy is smoothed with, so the ridge of a
// sustained hit is not chosen by which bin of its plateau happened to be
// loudest. Well under the shortest attack the analysis can resolve.
static constexpr int ONSET_RIDGE_SMOOTH_BINS = 2;
// Rise per bin, relative to the ridge window's peak, that still counts as the
// attack climbing rather than plateau noise.
static constexpr double ONSET_RIDGE_CLIMB = 0.01;
// How far back from the top of an attack its foot is looked for.
static constexpr double ONSET_ATTACK_SEARCH_SEC = 0.020;
// Height up the attack, as a share of the rise from its foot to its top, that
// counts as the hit having started. Above the very bottom, which on real
// material is the noise the attack grew out of rather than the attack itself.
static constexpr double ONSET_ATTACK_FOOT = 0.60;
// The analysis is non-causal: atoms positioned before an event see it, so a
// measured rise begins about this far ahead of the event itself. Added back to
// the anchor, so an impulse lands on its own time instead of a fraction of a
// millisecond early — which a transform amplifies into pre-echo by its
// stretch factor.
static constexpr double ONSET_SMEAR_COMP_SEC = 0.00035;
// Detection-function level, relative to the file maximum, below which a peak is
// silence rather than an event.
static constexpr double ONSET_FLOOR_RATIO = 0.02;
// Longest an event's level is looked for past its anchor, when no other event
// follows sooner. Covers the time the coarsest bands take to register a hit.
static constexpr double ONSET_LEVEL_POST_SEC = 0.150;
// How far before its first reported event a regional pass still reads
// coefficients, so the whitening's running peak reaches the value a whole-file
// pass would have had there. The peak jumps to any loud moment at once and only
// decays with the time constant, so a few of those bound the difference.
static constexpr double ONSET_WHITEN_WARMUP_SEC = 3.0 * ONSET_WHITEN_TAU_SEC;

/**
 * A detection restricted to part of a file: only events inside [startSec,
 * endSec) are reported, and only the coefficients bearing on those events are
 * read. Everything an event's own report depends on is local — its flux, its
 * anchor, its level — except the silence gate, which is a share of the loudest
 * moment anywhere in the file, so a regional pass is handed the previous pass's
 * gate and hands back whichever of the two is larger.
 */
struct OnsetRegion
{
    double startSec;
    double endSec;
    double odfReference;
    // Each band's loudest moment anywhere in the file, from that same pass.
    // Without it a regional pass has to scan every band in full to find them,
    // which costs more than everything else it does put together.
    const float *bandMaxReference;
    int bandMaxCount;
};

static std::vector<DetectedOnset> computeOnsets(const float *packed,
                                                size_t packedFloats,
                                                const OnsetBandLayout &layout,
                                                int64_t numFrames,
                                                double sampleRate,
                                                const OnsetRegion *region = nullptr,
                                                double *odfMaxOut = nullptr,
                                                std::vector<float> *bandMaxOut = nullptr,
                                                const OnsetPatchOverlay *overlay = nullptr)
{
    std::vector<DetectedOnset> onsets;
    if (!packed || layout.numBands <= 0 || numFrames <= 0 || sampleRate <= 0.0)
        return onsets;

    // The four floats of one coefficient, or null when it is out of bounds.
    const auto pixelAt = [&](int b, int64_t k) -> const float * {
        if (overlay)
        {
            const int64_t rel = k - overlay->k0[b];
            if (rel >= 0 && rel < overlay->count[b])
            {
                const size_t px = overlay->pixelBase[b] + (size_t)rel * 4;
                if (px + 3 < overlay->pixelFloats)
                    return overlay->pixels + px;
            }
        }
        const size_t px = ((size_t)layout.bandOffsets[b] + (size_t)k) * 4;
        if (px + 3 >= packedFloats)
            return nullptr;
        return packed + px;
    };

    const int channels = std::max(1, layout.numChannels);
    const float channelScale = 1.0f / (float)channels;
    const double durationSec = (double)numFrames / sampleRate;
    const int64_t numBins = std::max<int64_t>(1, (int64_t)std::ceil(durationSec / ONSET_BIN_SEC));

    double maxStrideSec = 0.0;
    for (int b = 0; b < layout.numBands; ++b)
        maxStrideSec = std::max(maxStrideSec, (double)(1LL << layout.bandStepLog2s[b]) / sampleRate);

    // The span of the file this pass reports on, and the wider span it has to
    // read for those reports to come out as they would from a whole-file pass:
    // the whitening needs its warm-up, a peak is judged against a mean taken
    // either side of it, and an event's level is measured for a moment after it.
    const double emitStartSec = region ? std::max(0.0, region->startSec) : 0.0;
    const double emitEndSec = region ? std::min(durationSec, region->endSec) : durationSec;
    if (emitEndSec <= emitStartSec)
        return onsets;
    const double leadSec = ONSET_WHITEN_WARMUP_SEC + ONSET_MEAN_PRE_SEC + 2.0 * maxStrideSec;
    const double trailSec =
        ONSET_LEVEL_POST_SEC + ONSET_MEAN_POST_SEC + ONSET_RIDGE_SEARCH_SEC + 2.0 * maxStrideSec;
    const double readStartSec = region ? std::max(0.0, emitStartSec - leadSec) : 0.0;
    const double readEndSec = region ? std::min(durationSec, emitEndSec + trailSec) : durationSec;

    // That span as a coefficient range on a band of the given stride.
    const auto coefLo = [readStartSec](uint32_t len, double strideSec) -> uint32_t {
        return (uint32_t)std::min<int64_t>((int64_t)len,
                                           std::max<int64_t>(0, (int64_t)std::floor(readStartSec / strideSec)));
    };
    const auto coefHi = [readEndSec](uint32_t len, double strideSec) -> uint32_t {
        return (uint32_t)std::min<int64_t>((int64_t)len, (int64_t)std::ceil(readEndSec / strideSec) + 2);
    };

    // Per-band whitened magnitudes. The max filter reads neighbouring bands at
    // this band's previous time position, so whole tracks are kept rather than
    // one previous frame.
    if (bandMaxOut)
        bandMaxOut->assign((size_t)std::max(0, layout.numBands), 0.0f);

    // Whitened magnitudes are held only over the span being read, so a regional
    // pass neither allocates nor clears the rest of the file. The range each
    // band holds is kept alongside it, since reads reach across bands.
    std::vector<std::vector<float>> whitened(layout.numBands);
    std::vector<uint32_t> bandKLo((size_t)std::max(0, layout.numBands), 0);
    std::vector<uint32_t> bandKHi((size_t)std::max(0, layout.numBands), 0);
    const auto whitenedAt = [&](int b, int64_t k) -> float {
        if (k < (int64_t)bandKLo[(size_t)b] || k >= (int64_t)bandKHi[(size_t)b])
            return 0.0f;
        return whitened[(size_t)b][(size_t)(k - bandKLo[(size_t)b])];
    };
    uint32_t longestBand = 0;
    for (int b = 0; b < layout.numBands; ++b)
        longestBand = std::max(longestBand, layout.bandLengths[b]);
    std::vector<float> compressed(longestBand, 0.0f);

    for (int b = 0; b < layout.numBands; ++b)
    {
        const uint32_t len = layout.bandLengths[b];
        if (len == 0)
            continue;
        const double strideSec = (double)(1LL << layout.bandStepLog2s[b]) / sampleRate;
        const float decay = (float)std::exp(-strideSec / ONSET_WHITEN_TAU_SEC);
        const uint32_t kLo = coefLo(len, strideSec);
        const uint32_t kHi = coefHi(len, strideSec);
        bandKLo[(size_t)b] = kLo;
        bandKHi[(size_t)b] = kHi;
        whitened[b].assign(kHi > kLo ? (size_t)(kHi - kLo) : 0, 0.0f);

        for (uint32_t k = kLo; k < kHi; ++k)
        {
            compressed[k] = 0.0f;
            const float *p = pixelAt(b, (int64_t)k);
            if (!p)
                continue;
            float mag = 0.0f;
            for (int ch = 0; ch < channels; ++ch)
                mag += p[ch * 2];
            compressed[k] = std::log1p(ONSET_LOG_GAMMA * std::max(0.0f, mag * channelScale));
        }

        // The band's loudest moment anywhere in the file, so the floor below is
        // the one a whole-file pass would use however little of the band this
        // pass reads. What has been painted into the span being read can be
        // louder than the file used to be, which is why the reference is a
        // starting point rather than the answer.
        float bandMax = 0.0f;
        for (uint32_t k = kLo; k < kHi; ++k)
            bandMax = std::max(bandMax, compressed[k]);
        if (region && b < region->bandMaxCount && region->bandMaxReference)
        {
            bandMax = std::max(bandMax, region->bandMaxReference[b]);
        }
        else if (region)
        {
            // Nothing to go on, so find it directly. Read off the magnitudes
            // rather than the compressed values: the compression is monotonic,
            // so the largest magnitude is the largest compressed value, and the
            // scan then costs no transcendentals.
            float maxMag = 0.0f;
            for (uint32_t k = 0; k < len; ++k)
            {
                const float *p = pixelAt(b, (int64_t)k);
                if (!p)
                    continue;
                float mag = 0.0f;
                for (int ch = 0; ch < channels; ++ch)
                    mag += p[ch * 2];
                maxMag = std::max(maxMag, mag * channelScale);
            }
            bandMax = std::max(bandMax, std::log1p(ONSET_LOG_GAMMA * std::max(0.0f, maxMag)));
        }
        if (bandMaxOut)
            (*bandMaxOut)[b] = bandMax;

        // Whitening is meant to put the bands on equal terms, not to promote
        // what is effectively silence in one of them. Held off the band's own
        // maximum rather than off an absolute floor: with only an absolute
        // floor, a band opens the file whitening against nothing, so the first
        // thing to reach it — the analysis ringing ahead of the first hit, which
        // in the slowest bands begins a twelfth of a second early — is scaled to
        // full and read as an event of its own.
        const float floorLevel = std::max(ONSET_WHITEN_FLOOR, ONSET_WHITEN_FLOOR_RATIO * bandMax);
        float peak = floorLevel;
        for (uint32_t k = kLo; k < kHi; ++k)
        {
            peak = std::max(std::max(compressed[k], decay * peak), floorLevel);
            whitened[b][k - kLo] = compressed[k] / peak;
        }
    }

    // A band deposits one coefficient every stride samples, so dropping each
    // whole contribution into the single bin it starts in makes the low bands —
    // whose stride is tens of milliseconds — spike periodically and swamp
    // everything else. Each contribution is instead spread across the time the
    // coefficient covers, which turns every band into something that can be
    // summed with the others.
    //
    // Spread as a triangle peaking at the coefficient's own position rather
    // than as a flat block over it. A block has no single highest point, so
    // peak picking would take its leading edge — for the slowest bands a
    // twelfth of a second before the hit that made it, reporting every first
    // hit in a file twice. Triangles a stride wide, a stride apart, also sum
    // to exactly the value they carry, so a steady band reads as a steady
    // level rather than rippling at its own sampling rate.
    //
    // Accumulated as second differences and integrated twice, so the cost does
    // not grow with how far each one is spread. The padding holds the part of a
    // triangle that falls outside the file, which still has to be integrated
    // through for the part inside it to come out right.
    int64_t maxSpan = 1;
    for (int b = 0; b < layout.numBands; ++b)
    {
        const double strideSec = (double)(1LL << layout.bandStepLog2s[b]) / sampleRate;
        maxSpan = std::max(maxSpan, (int64_t)std::ceil(strideSec / ONSET_BIN_SEC));
    }
    const int64_t pad = maxSpan + 2;
    const size_t curveLen = (size_t)(numBins + 2 * pad + 2);
    std::vector<double> fluxD2(curveLen, 0.0);
    std::vector<double> complexD2(curveLen, 0.0);
    std::vector<double> energyD2(curveLen, 0.0);

    const auto addTriangle = [pad](std::vector<double> &d2, int64_t centre, int64_t half, double peak) {
        const double slope = peak / (double)half;
        d2[(size_t)(pad + centre - half + 1)] += slope;
        d2[(size_t)(pad + centre + 1)] -= 2.0 * slope;
        d2[(size_t)(pad + centre + half + 1)] += slope;
    };

    for (int b = 0; b < layout.numBands; ++b)
    {
        const uint32_t len = layout.bandLengths[b];
        if (len == 0)
            continue;
        const int64_t stride = 1LL << layout.bandStepLog2s[b];
        const double strideSec = (double)stride / sampleRate;
        const double binsPerCoef = strideSec / ONSET_BIN_SEC;
        // Half-width of each triangle: a stride, rounded up so that consecutive
        // ones overlap rather than leaving gaps between them.
        const int64_t span = std::max<int64_t>(1, (int64_t)std::ceil(binsPerCoef));
        // The rate curves carry the same total per coefficient however wide it
        // is spread, so their peak is divided by the width.
        const double spread = 1.0 / (double)span;
        const int nbLo = std::max(0, b - ONSET_MAX_FILTER_BANDS);
        const int nbHi = std::min(layout.numBands - 1, b + ONSET_MAX_FILTER_BANDS);
        const uint32_t kLo = coefLo(len, strideSec);
        const uint32_t kHi = coefHi(len, strideSec);

        for (uint32_t k = kLo; k < kHi; ++k)
        {
            const float *p = pixelAt(b, (int64_t)k);
            if (!p)
                break;
            // The bin whose centre is nearest the coefficient's own time. A
            // floor here would place every coefficient up to a whole bin late
            // and by a different amount per band, since a bin carries what sits
            // at its centre rather than at its start.
            const int64_t centre =
                std::max<int64_t>(0, std::min(numBins - 1, (int64_t)std::llround((double)k * binsPerCoef - 0.5)));

            float mag = 0.0f;
            for (int ch = 0; ch < channels; ++ch)
                mag += p[ch * 2];
            mag *= channelScale;
            addTriangle(energyD2, centre, span, mag * spread);

            // Before the file there is nothing, so the first coefficient of a
            // band is compared against silence and everything in it counts as
            // having arrived. Without that the flux term is blind for a stride
            // at every band, and a file that opens on a hit reports it late,
            // weakly, or not at all — while a file that opens on silence has
            // nothing in that first coefficient to report either way.
            float maxNeighbor = 0.0f;
            if (k > 0)
            {
                const int64_t prevSample = (int64_t)(k - 1) * stride;
                for (int nb = nbLo; nb <= nbHi; ++nb)
                {
                    const uint32_t nlen = layout.bandLengths[nb];
                    if (nlen == 0)
                        continue;
                    const int64_t idx = std::min<int64_t>(prevSample >> layout.bandStepLog2s[nb], (int64_t)nlen - 1);
                    maxNeighbor = std::max(maxNeighbor, whitenedAt(nb, idx));
                }
            }
            const float d = whitenedAt(b, (int64_t)k) - maxNeighbor;
            if (d > 0.0f)
                addTriangle(fluxD2, centre, span, (double)d * spread);

            if (k < 2)
                continue;

            // Stored phase is unwrapped per band, so the steady-state
            // prediction is a straight linear extrapolation and the deviation
            // is the distance between the predicted and the actual atom. Only
            // the phase difference between the two survives the law of cosines,
            // so this costs one cosine rather than four.
            const float *pPrev = pixelAt(b, (int64_t)k - 1);
            const float *pPrev2 = pixelAt(b, (int64_t)k - 2);
            if (!pPrev || !pPrev2)
                continue;
            float relDev = 0.0f;
            for (int ch = 0; ch < channels; ++ch)
            {
                const float magK = p[ch * 2];
                const float magP = pPrev[ch * 2];
                const float dPhi = p[ch * 2 + 1] - 2.0f * pPrev[ch * 2 + 1] + pPrev2[ch * 2 + 1];
                const float dev = std::sqrt(std::max(0.0f, magK * magK + magP * magP -
                                                               2.0f * magK * magP * std::cos(dPhi)));
                // Taken relative to the magnitudes involved, so the term is a
                // dimensionless prediction error rather than a level.
                relDev += dev / (magK + magP + 1e-9f);
            }
            // Gated by the whitened magnitude, so it only counts where there is
            // content and lands on the same scale as the flux term.
            const double cdev = (double)(whitenedAt(b, (int64_t)k) * relDev * channelScale);
            addTriangle(complexD2, centre, span, cdev * spread);
        }
    }

    std::vector<double> odf((size_t)numBins, 0.0);
    std::vector<double> energy((size_t)numBins, 0.0);
    std::vector<double> prefix((size_t)numBins + 1, 0.0);
    double fluxSlope = 0.0, fluxRun = 0.0;
    double complexSlope = 0.0, complexRun = 0.0;
    double energySlope = 0.0, energyRun = 0.0;
    double maxOdf = 0.0;
    for (size_t i = 0; i < curveLen; ++i)
    {
        fluxSlope += fluxD2[i];
        fluxRun += fluxSlope;
        complexSlope += complexD2[i];
        complexRun += complexSlope;
        energySlope += energyD2[i];
        energyRun += energySlope;

        const int64_t bin = (int64_t)i - pad;
        if (bin < 0 || bin >= numBins)
            continue;
        odf[bin] = std::max(0.0, fluxRun + ONSET_COMPLEX_WEIGHT * complexRun);
        energy[bin] = std::max(0.0, energyRun);
        prefix[bin + 1] = prefix[bin] + odf[bin];
        maxOdf = std::max(maxOdf, odf[bin]);
    }
    // A regional pass only sees its own part of the curve, so the gate comes
    // from the whole-file value it was handed, raised if what was painted into
    // the region turns out to be louder than anything the file had before.
    const double odfGate = region ? std::max(maxOdf, region->odfReference) : maxOdf;
    if (odfMaxOut)
        *odfMaxOut = odfGate;
    if (odfGate <= 0.0)
        return onsets;

    // Smoothed for choosing which bin the top of an attack is, kept raw for
    // measuring where that attack began: smoothing spreads a rise across its
    // own width, so walking down a smoothed one lands a smoothing-width early —
    // on a click, whose energy rises inside a single bin, that is the whole
    // error.
    std::vector<double> rawEnergy(energy);
    {
        std::vector<double> energyPrefix((size_t)numBins + 1, 0.0);
        for (int64_t i = 0; i < numBins; ++i)
            energyPrefix[i + 1] = energyPrefix[i] + energy[i];
        for (int64_t i = 0; i < numBins; ++i)
        {
            const int64_t lo = std::max<int64_t>(0, i - ONSET_RIDGE_SMOOTH_BINS);
            const int64_t hi = std::min<int64_t>(numBins, i + ONSET_RIDGE_SMOOTH_BINS + 1);
            energy[i] = (energyPrefix[hi] - energyPrefix[lo]) / (double)(hi - lo);
        }
    }

    const int64_t peakWin = std::max<int64_t>(1, (int64_t)std::llround(ONSET_PEAK_WINDOW_SEC / ONSET_BIN_SEC));
    const int64_t meanPre = std::max<int64_t>(1, (int64_t)std::llround(ONSET_MEAN_PRE_SEC / ONSET_BIN_SEC));
    const int64_t meanPost = std::max<int64_t>(1, (int64_t)std::llround(ONSET_MEAN_POST_SEC / ONSET_BIN_SEC));
    const int64_t minGap = std::max<int64_t>(1, (int64_t)std::llround(ONSET_MIN_GAP_SEC / ONSET_BIN_SEC));
    const int64_t ridgeSearch = std::max<int64_t>(1, (int64_t)std::llround(ONSET_RIDGE_SEARCH_SEC / ONSET_BIN_SEC));
    const int64_t attackSearch = std::max<int64_t>(1, (int64_t)std::llround(ONSET_ATTACK_SEARCH_SEC / ONSET_BIN_SEC));
    const double floorLevel = odfGate * ONSET_FLOOR_RATIO;
    const int64_t emitLo = std::max<int64_t>(0, (int64_t)std::floor(emitStartSec / ONSET_BIN_SEC));
    const int64_t emitHi = std::min<int64_t>(numBins, (int64_t)std::ceil(emitEndSec / ONSET_BIN_SEC));
    // A regional pass looks for candidates either side of the span it reports
    // on. Before it, because the detection function peaks on the rising edge
    // while the event is anchored at the foot of the attack, so a peak just
    // outside can still belong to an event just inside. After it, because how
    // big an event is depends on where the next one starts, and the last event
    // in the span would otherwise be measured as if nothing followed.
    const int64_t pickLo =
        region ? std::max<int64_t>(0, emitLo - (int64_t)std::llround((ONSET_RIDGE_SEARCH_SEC +
                                                                     ONSET_ATTACK_SEARCH_SEC) /
                                                                    ONSET_BIN_SEC))
               : 0;
    const int64_t pickHi =
        region ? std::min<int64_t>(numBins, emitHi + (int64_t)std::llround(ONSET_LEVEL_POST_SEC / ONSET_BIN_SEC))
               : numBins;
    int64_t lastBin = pickLo - minGap;

    // Where each event is, found first; how big it is needs the next one's
    // position, so that is measured in a second pass.
    std::vector<double> candidates;

    for (int64_t n = pickLo; n < pickHi; ++n)
    {
        const double v = odf[n];
        if (v <= floorLevel || n - lastBin < minGap)
            continue;

        const int64_t lo = std::max<int64_t>(0, n - peakWin);
        const int64_t hi = std::min<int64_t>(numBins - 1, n + peakWin);
        bool isPeak = true;
        for (int64_t j = lo; j < n && isPeak; ++j)
            isPeak = odf[j] < v;
        for (int64_t j = n + 1; j <= hi && isPeak; ++j)
            isPeak = odf[j] <= v;
        if (!isPeak)
            continue;

        const int64_t mLo = std::max<int64_t>(0, n - meanPre);
        const int64_t mHi = std::min<int64_t>(numBins, n + meanPost + 1);
        const double localMean = (prefix[mHi] - prefix[mLo]) / (double)(mHi - mLo);
        if (v < localMean * ONSET_THRESHOLD_RATIO)
            continue;

        // Find the top of the attack: the first bin reaching the window's level
        // and any further rise it sits on. An impulse gives a genuine peak, but
        // a sustained hit gives a plateau on which the argmax is decided by
        // noise, so both shapes land on the same edge this way.
        const int64_t rHi = std::min<int64_t>(numBins - 1, n + ridgeSearch);
        double windowPeak = 0.0;
        for (int64_t j = n; j <= rHi; ++j)
            windowPeak = std::max(windowPeak, energy[j]);

        int64_t ridgeBin = rHi;
        for (int64_t j = n; j <= rHi; ++j)
        {
            if (energy[j] >= windowPeak * ONSET_RIDGE_ARRIVAL)
            {
                ridgeBin = j;
                break;
            }
        }
        while (ridgeBin < rHi && energy[ridgeBin + 1] - energy[ridgeBin] > windowPeak * ONSET_RIDGE_CLIMB)
            ++ridgeBin;

        // Then walk back down it to where the attack began. The top of an
        // attack is not when it happened — a hit is heard, and a transported
        // transient is placed, at the moment its energy starts rising, and on a
        // quantized loop anchoring at the top sits a consistent few
        // milliseconds behind the grid the material was cut on. How far back
        // that is depends on the hit: a click rises within a bin, a noise burst
        // over several.
        const int64_t footLimit = std::max<int64_t>(0, ridgeBin - attackSearch);
        double preFloor = rawEnergy[ridgeBin];
        for (int64_t j = ridgeBin; j >= footLimit; --j)
            preFloor = std::min(preFloor, rawEnergy[j]);
        const double footLevel = preFloor + (rawEnergy[ridgeBin] - preFloor) * ONSET_ATTACK_FOOT;

        int64_t bestBin = ridgeBin;
        while (bestBin > footLimit && rawEnergy[bestBin - 1] > footLevel)
            --bestBin;

        // Sub-bin position of the crossing itself, so the anchor is not
        // quantized to the detection function's grid.
        double delta = 0.0;
        if (bestBin > 0)
        {
            const double below = rawEnergy[bestBin - 1];
            const double above = rawEnergy[bestBin];
            if (above > below)
                delta = -std::max(0.0, std::min(1.0, (above - footLevel) / (above - below)));
        }

        const double timeSec = std::min(
            durationSec, std::max(0.0, ((double)bestBin + 0.5 + delta) * ONSET_BIN_SEC + ONSET_SMEAR_COMP_SEC));
        candidates.push_back(timeSec);
        lastBin = n;
    }

    // How big each event is: the power that arrives with it. Per band, the peak
    // power reached between this onset and the next, less the power just before
    // it, counted only where it rises — so a sound stopping scores nothing
    // however loud what ended was, and a hit in one band is not credited to a
    // neighbouring event. Read off each band's own stored coefficients rather
    // than any curve summed across bands: the slowest bands cover so much time
    // each that a summed curve smears adjacent events into each other in busy
    // material. Power because that is what tracks the signal's own level — a
    // kick and a hi-hat 24 dB apart come out in the ratio of their true levels
    // to within a few percent, where bare magnitudes read 5:1 — and reported as
    // an amplitude, so saliences stand in the same ratios as the hits do.
    onsets.reserve(candidates.size());
    for (size_t i = 0; i < candidates.size(); ++i)
    {
        const double tSec = candidates[i];
        // Candidates found past the reported span, and events whose walk back
        // down the attack landed before it, are here only to bound the ones
        // inside it: the caller replaces exactly that span and keeps its own
        // onsets either side.
        if (region && (tSec < emitStartSec || tSec >= emitEndSec))
            continue;
        double tEndSec = std::min(durationSec, tSec + ONSET_LEVEL_POST_SEC);
        if (i + 1 < candidates.size())
            tEndSec = std::min(tEndSec, candidates[i + 1]);
        const int64_t sample = (int64_t)(tSec * sampleRate);
        const int64_t sampleEnd = (int64_t)(tEndSec * sampleRate);

        double arrived = 0.0;
        for (int b = 0; b < layout.numBands; ++b)
        {
            const uint32_t len = layout.bandLengths[b];
            if (len == 0)
                continue;
            const int32_t stepLog2 = layout.bandStepLog2s[b];
            const double strideSec = (double)(1LL << stepLog2) / sampleRate;
            const int64_t j0 = std::min<int64_t>((int64_t)len - 1, std::max<int64_t>(0, sample >> stepLog2));
            const int64_t jEnd = std::min<int64_t>((int64_t)len - 1, std::max<int64_t>(j0, sampleEnd >> stepLog2));
            // A band whose stride is longer than this event's window cannot
            // tell this event from its neighbours — the coefficient holding the
            // onset holds them too, so its power would be credited to every
            // event within a stride of a loud hit. Such a band only counts for
            // the share of its span this event owns.
            const double owned = std::min(1.0, (tEndSec - tSec) / strideSec);

            const auto powerAt = [&](int64_t j) -> double {
                if (j < 0 || j >= (int64_t)len)
                    return 0.0;
                const float *p = pixelAt(b, j);
                if (!p)
                    return 0.0;
                float m = 0.0f;
                for (int ch = 0; ch < channels; ++ch)
                    m += p[ch * 2];
                m *= channelScale;
                return (double)m * (double)m;
            };
            // Averaged over three coefficients so that noise is compared as an
            // envelope: a noisy band's coefficients scatter, and the maximum of
            // many raw draws beats any single one, which would read a noise
            // tail's own fluctuation as new energy arriving.
            const auto envAt = [&](int64_t j, int64_t cap) -> double {
                return (powerAt(j - 1) + powerAt(j) + powerAt(std::min(j + 1, cap))) / 3.0;
            };

            // The last envelope wholly before the coefficient containing the
            // onset.
            const double pre = envAt(j0 - 2, jEnd);
            double post = 0.0;
            for (int64_t j = j0; j <= jEnd; ++j)
                post = std::max(post, envAt(j, jEnd));
            arrived += std::max(0.0, post - pre) * owned;
        }
        onsets.push_back({tSec, (float)std::sqrt(arrived)});
    }

    return onsets;
}

class OnsetWorker : public Napi::AsyncWorker
{
public:
    OnsetWorker(Napi::Env env, const Napi::Float32Array &packedJs, const Napi::Object &metaJs, double sampleRate,
                const Napi::Value &optionsJs)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), sampleRate(sampleRate)
    {
        // A region asks for the onsets of one span of the file only, given the
        // gate a previous pass over the whole of it arrived at.
        if (optionsJs.IsObject())
        {
            Napi::Object options = optionsJs.As<Napi::Object>();
            if (options.Has("startSec") && options.Has("endSec"))
            {
                region.startSec = options.Get("startSec").ToNumber().DoubleValue();
                region.endSec = options.Get("endSec").ToNumber().DoubleValue();
                region.odfReference =
                    options.Has("odfReference") ? options.Get("odfReference").ToNumber().DoubleValue() : 0.0;
                if (options.Has("bandMax") && options.Get("bandMax").IsTypedArray())
                {
                    Napi::Float32Array bm = options.Get("bandMax").As<Napi::Float32Array>();
                    bandMaxIn.assign(bm.Data(), bm.Data() + bm.ElementLength());
                    region.bandMaxReference = bandMaxIn.data();
                    region.bandMaxCount = (int)bandMaxIn.size();
                }
                hasRegion = true;
            }
        }

        // Held by reference and read from its backing store on the worker
        // thread, like synthesis — the caller must not mutate it in flight.
        packedRef = Napi::Reference<Napi::Float32Array>::New(packedJs, 1);
        packed = packedJs.Data();
        packedFloats = packedJs.ElementLength();

        numBands = metaJs.Get("numBands").As<Napi::Number>().Int32Value();
        numChannels = metaJs.Get("numChannels").As<Napi::Number>().Int32Value();
        numFrames = metaJs.Get("numFrames").As<Napi::Number>().Int64Value();

        Napi::Uint32Array bo = metaJs.Get("bandOffsets").As<Napi::Uint32Array>();
        bandOffsets.assign(bo.Data(), bo.Data() + bo.ElementLength());

        Napi::Uint32Array bl = metaJs.Get("bandLengths").As<Napi::Uint32Array>();
        bandLengths.assign(bl.Data(), bl.Data() + bl.ElementLength());

        Napi::Int32Array bs = metaJs.Get("bandStepLog2s").As<Napi::Int32Array>();
        bandStepLog2s.assign(bs.Data(), bs.Data() + bs.ElementLength());
    }

    Napi::Promise GetPromise() { return deferred.Promise(); }

    void Execute() override
    {
        OnsetBandLayout layout;
        layout.numBands = std::min<int>(numBands, (int)std::min(bandOffsets.size(),
                                                                std::min(bandLengths.size(), bandStepLog2s.size())));
        layout.numChannels = numChannels;
        layout.bandOffsets = bandOffsets.data();
        layout.bandLengths = bandLengths.data();
        layout.bandStepLog2s = bandStepLog2s.data();
        onsets = computeOnsets(packed, packedFloats, layout, numFrames, sampleRate, hasRegion ? &region : nullptr,
                               &odfMax, &bandMaxOut);
    }

    void OnOK() override
    {
        Napi::Env env = Env();
        Napi::HandleScope scope(env);
        Napi::Object result = Napi::Object::New(env);
        result.Set("onsets", packOnsets(env, onsets));
        // What this pass learned about the file as a whole, to be handed back on
        // the next regional one so it judges its own span on the same terms.
        result.Set("odfMax", Napi::Number::New(env, odfMax));
        result.Set("bandMax", packBandMax(env, bandMaxOut));
        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }

    static Napi::Float32Array packBandMax(Napi::Env env, const std::vector<float> &bandMax)
    {
        Napi::Float32Array out = Napi::Float32Array::New(env, bandMax.size());
        if (!bandMax.empty())
            memcpy(out.Data(), bandMax.data(), bandMax.size() * sizeof(float));
        return out;
    }

    // Flat [time0, salience0, time1, salience1, …] in seconds.
    static Napi::Float32Array packOnsets(Napi::Env env, const std::vector<DetectedOnset> &onsets)
    {
        Napi::Float32Array out = Napi::Float32Array::New(env, onsets.size() * 2);
        for (size_t i = 0; i < onsets.size(); ++i)
        {
            out[i * 2] = (float)onsets[i].timeSec;
            out[i * 2 + 1] = onsets[i].salience;
        }
        return out;
    }

private:
    Napi::Promise::Deferred deferred;
    OnsetRegion region{0.0, 0.0, 0.0, nullptr, 0};
    bool hasRegion = false;
    std::vector<float> bandMaxIn;
    std::vector<float> bandMaxOut;
    double odfMax = 0.0;
    Napi::Reference<Napi::Float32Array> packedRef;
    const float *packed = nullptr;
    size_t packedFloats = 0;
    double sampleRate;
    int numBands = 0;
    int numChannels = 1;
    int64_t numFrames = 0;
    std::vector<uint32_t> bandOffsets;
    std::vector<uint32_t> bandLengths;
    std::vector<int32_t> bandStepLog2s;
    std::vector<DetectedOnset> onsets;
};

Napi::Value DetectOnsetsAsync(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsTypedArray() || !info[1].IsObject() || !info[2].IsNumber())
    {
        Napi::TypeError::New(env, "Expected: packedData (Float32Array), meta (Object), sampleRate (Number), [options (Object)]").ThrowAsJavaScriptException();
        return env.Null();
    }

    OnsetWorker *worker = new OnsetWorker(env,
                                          info[0].As<Napi::Float32Array>(),
                                          info[1].As<Napi::Object>(),
                                          info[2].As<Napi::Number>().DoubleValue(),
                                          info.Length() > 3 ? info[3] : env.Undefined());
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
                     bool applyLimiter,
                     const Napi::Array &existingAudioJs,
                     int64_t startFrame,
                     int64_t endFrame,
                     int64_t startBand,
                     int64_t endBand)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), sampleRate(sampleRate), applyLimiter(applyLimiter),
          requestedStartFrame(startFrame), requestedEndFrame(endFrame), requestedStartBand(startBand), requestedEndBand(endBand)
    {
        // Hold the packed FBO buffer by reference and read it straight from its
        // backing store on the worker thread. The reference keeps the JS array
        // alive across the async boundary; the caller does not mutate it while
        // synthesis is in flight, so the worker reads it without a copy.
        inputDataRef = Napi::Reference<Napi::Float32Array>::New(inputDataJs, 1);
        inputData = inputDataJs.Data();
        inputDataLen = inputDataJs.ElementLength();

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
        // Onsets are re-derived from the packed data this pass already walks, so
        // they track what has been painted. Full-file work regardless of the
        // synthesized range, hence opt-in per call.
        detectOnsets = paramsJs.Has("detectOnsets") && paramsJs.Get("detectOnsets").ToBoolean().Value();
        if (detectOnsets && paramsJs.Has("onsetStartSec") && paramsJs.Has("onsetEndSec"))
        {
            onsetRegion.startSec = paramsJs.Get("onsetStartSec").ToNumber().DoubleValue();
            onsetRegion.endSec = paramsJs.Get("onsetEndSec").ToNumber().DoubleValue();
            onsetRegion.odfReference =
                paramsJs.Has("onsetOdfReference") ? paramsJs.Get("onsetOdfReference").ToNumber().DoubleValue() : 0.0;
            if (paramsJs.Has("onsetBandMax") && paramsJs.Get("onsetBandMax").IsTypedArray())
            {
                Napi::Float32Array bm = paramsJs.Get("onsetBandMax").As<Napi::Float32Array>();
                onsetBandMaxIn.assign(bm.Data(), bm.Data() + bm.ElementLength());
                onsetRegion.bandMaxReference = onsetBandMaxIn.data();
                onsetRegion.bandMaxCount = (int)onsetBandMaxIn.size();
            }
            hasOnsetRegion = true;
        }

        // Reference the existing audio channels (for partial synthesis with
        // crossfade) and read them by pointer on the worker thread, same as the
        // packed buffer.
        if (existingAudioJs.Length() > 0)
        {
            uint32_t len = existingAudioJs.Length();
            existingAudio.reserve(len);
            existingAudioLens.reserve(len);
            existingAudioRefs.reserve(len);
            for (uint32_t i = 0; i < len; i++)
            {
                Napi::Float32Array channelJs = existingAudioJs.Get(i).As<Napi::Float32Array>();
                existingAudioRefs.push_back(Napi::Reference<Napi::Float32Array>::New(channelJs, 1));
                existingAudio.push_back(channelJs.Data());
                existingAudioLens.push_back(channelJs.ElementLength());
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
        const PackedCoefs packedView{inputData, inputDataLen, bandOffsets.data(), bandLengths.data(),
                                     bandStepLog2s.data(), numBands};

        for (int ch = 0; ch < channels; ++ch)
        {
            DEBUG_LOG << "[C++] Processing channel " << ch << std::endl << std::flush;
            gaborator::coefs<float> channelCoefs(analyzer);
            fillCoefsFromPacked(packedView, ch, band_begin, band_end, fillStart, fillEnd, channelCoefs);

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
                audioChannels[ch].assign(existingAudio[ch], existingAudio[ch] + existingAudioLens[ch]);
                crossfadeSpliceInto(audioChannels[ch], existingAudio[ch], synthesizedBuffers[ch], synthStart,
                                    synthEnd, static_cast<int64_t>(numFrames), crossfadeSamples);
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
        }

        // Limit the fully assembled buffer in one pass so the gain envelope is
        // continuous across the whole file — limiting the dirty block alone would
        // leave a gain discontinuity where it meets the surrounding audio. Existing
        // audio is already at or below the ceiling, so it passes through unchanged.
        // The flag lets the caller bypass the limiter.
        std::vector<float> gainEnv;
        if (applyLimiter)
            applyLookaheadLimiter(audioChannels, sampleRate, 40.0f, 200.0f, &gainEnv);

        // Downsample the applied gain into a compact per-file gain-reduction
        // envelope (dB of reduction, >= 0) for the meter. Each point holds the
        // worst reduction over a ~5 ms hop so brief dips stay visible, and the
        // points span the whole buffer evenly so the renderer can index it by
        // playback fraction.
        gainReductionDb.clear();
        maxGainReductionDb = 0.0f;
        if (!gainEnv.empty())
        {
            const int hop = std::max(1, static_cast<int>(std::lround(sampleRate * 0.005)));
            const size_t points = (gainEnv.size() + hop - 1) / hop;
            gainReductionDb.resize(points);
            float minGain = 1.0f;
            for (size_t p = 0; p < points; ++p)
            {
                const size_t start = p * static_cast<size_t>(hop);
                const size_t end = std::min(gainEnv.size(), start + static_cast<size_t>(hop));
                float lo = 1.0f;
                for (size_t i = start; i < end; ++i)
                    lo = std::min(lo, gainEnv[i]);
                minGain = std::min(minGain, lo);
                gainReductionDb[p] = lo < 1.0f ? -20.0f * std::log10(lo) : 0.0f;
            }
            maxGainReductionDb = minGain < 1.0f ? -20.0f * std::log10(minGain) : 0.0f;
        }

        // Compute peak of the complete, limited buffer.
        peakValue = 0.0f;
        for (const auto &channel_data : audioChannels)
        {
            for (float sample : channel_data)
            {
                peakValue = std::max(peakValue, std::abs(sample));
            }
        }
        DEBUG_LOG << "[C++] Peak value: " << peakValue << std::endl << std::flush;

        if (detectOnsets)
        {
            OnsetBandLayout layout;
            layout.numBands = std::min<int>(numBands, (int)std::min(bandOffsets.size(),
                                                                    std::min(bandLengths.size(), bandStepLog2s.size())));
            layout.numChannels = channels;
            layout.bandOffsets = bandOffsets.data();
            layout.bandLengths = bandLengths.data();
            layout.bandStepLog2s = bandStepLog2s.data();
            // A stroke changes one span of the file, so only that span's onsets
            // are worth finding again; the caller splices them into the ones it
            // already has. Without a region — the first pass over a file — the
            // whole of it is read.
            onsets = computeOnsets(inputData, inputDataLen, layout, (int64_t)numFrames, sampleRate,
                                   hasOnsetRegion ? &onsetRegion : nullptr, &onsetOdfMax, &onsetBandMaxOut);
            DEBUG_LOG << "[C++] Detected " << onsets.size() << " onsets" << std::endl << std::flush;
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
        result.Set("peak", Napi::Number::New(env, peakValue));

        Napi::Float32Array grBuffer = Napi::Float32Array::New(env, gainReductionDb.size());
        if (!gainReductionDb.empty())
            memcpy(grBuffer.Data(), gainReductionDb.data(), gainReductionDb.size() * sizeof(float));
        result.Set("gainReductionDb", grBuffer);
        result.Set("maxGainReductionDb", Napi::Number::New(env, maxGainReductionDb));
        if (detectOnsets)
        {
            result.Set("onsets", OnsetWorker::packOnsets(env, onsets));
            result.Set("onsetOdfMax", Napi::Number::New(env, onsetOdfMax));
            result.Set("onsetBandMax", OnsetWorker::packBandMax(env, onsetBandMaxOut));
        }

        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e)
    {
        deferred.Reject(e.Value());
    }

    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;

    // Input data, referenced in place rather than copied. The References keep the
    // JS backing buffers alive while Execute() reads them off the main thread.
    Napi::Reference<Napi::Float32Array> inputDataRef;
    const float *inputData = nullptr;
    size_t inputDataLen = 0;
    double sampleRate;
    bool applyLimiter;
    size_t numFrames;
    int channels;
    int numBands;
    std::vector<uint32_t> bandOffsets;
    std::vector<uint32_t> bandLengths;
    std::vector<int32_t> bandStepLog2s;
    int bandsPerOctave;
    double fminHz;
    bool detectOnsets = false;
    OnsetRegion onsetRegion{0.0, 0.0, 0.0, nullptr, 0};
    bool hasOnsetRegion = false;
    std::vector<float> onsetBandMaxIn;
    std::vector<float> onsetBandMaxOut;
    double onsetOdfMax = 0.0;
    int64_t requestedStartFrame;
    int64_t requestedEndFrame;
    int64_t requestedStartBand;
    int64_t requestedEndBand;
    std::vector<Napi::Reference<Napi::Float32Array>> existingAudioRefs;
    std::vector<const float *> existingAudio;
    std::vector<size_t> existingAudioLens;

    // Results
    std::vector<std::vector<float>> audioChannels;
    float peakValue = 0.0f;
    std::vector<float> gainReductionDb;
    float maxGainReductionDb = 0.0f;
    std::vector<DetectedOnset> onsets;
};

Napi::Value SynthesizeAsync(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 6 || !info[0].IsTypedArray() || !info[1].IsObject() || !info[2].IsNumber() || !info[3].IsObject() || !info[4].IsBoolean() || !info[5].IsArray())
    {
        Napi::TypeError::New(env, "Expected: data (TypedArray), analysisObject (Object), sampleRate (Number), params (Object), applyLimiter (Boolean), existingAudio (Array), [startFrame], [endFrame], [startBand], [endBand]").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array inputDataJs = info[0].As<Napi::Float32Array>();
    Napi::Object analysisObj = info[1].As<Napi::Object>();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();
    Napi::Object paramsJs = info[3].As<Napi::Object>();
    bool applyLimiter = info[4].As<Napi::Boolean>().Value();
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

    SynthesizeWorker *worker = new SynthesizeWorker(env, inputDataJs, analysisObj, sampleRate, paramsJs, applyLimiter, existingAudioJs, startFrame, endFrame, startBand, endBand);
    worker->Queue();
    return worker->GetPromise();
}

// ─── Stroke commit ───────────────────────────────────────────────────────────
//
// Everything a finished stroke derives, in one pass over one snapshot: the
// audio, the hard-edge gate, the limiter, the coefficients the audio actually
// analyzes to, the onsets and the output levels.
//
// The canvas is projected through the audio — synthesize the stroke's window,
// re-analyze it, hand the coefficients back as a patch. Analysis and synthesis
// reconstruct perfectly, so the projection is idempotent: committing twice
// changes nothing the second time. What it buys is that the picture is the
// analysis of what will be heard, so a phase-only edit shows, and no coefficient
// survives that synthesis would discard.

/** How much of the file one point of the levels and the envelope covers. */
static constexpr double COMMIT_LEVEL_HOP_SEC = 0.005;
/** Reconstruction ripple synthesis can add to full-scale material on its own
    (measured up to ~0.7 dB); sample peaks within it do not count as over. */
static constexpr float COMMIT_OVER_TOLERANCE_DB = 1.0f;
/** Longest analysis margin a band is given, however wide its filter. */
static constexpr double COMMIT_MAX_ANALYSIS_MARGIN_SEC = 2.0;

class CommitStrokeWorker : public Napi::AsyncWorker
{
public:
    CommitStrokeWorker(Napi::Env env,
                       const Napi::Float32Array &packedJs,
                       const Napi::Object &metaObj,
                       double sampleRate,
                       const Napi::Object &paramsJs,
                       const Napi::Array &existingAudioJs,
                       const Napi::Object &windowObj,
                       const Napi::Object &strokeObj)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), sampleRate(sampleRate)
    {
        // Held by reference and read from its backing store on the worker
        // thread. Never written: the patch alone carries this pass's changes.
        packedRef = Napi::Reference<Napi::Float32Array>::New(packedJs, 1);
        packed = packedJs.Data();
        packedLen = packedJs.ElementLength();

        numFrames = metaObj.Get("numFrames").As<Napi::Number>().Int64Value();
        channels = metaObj.Get("numChannels").As<Napi::Number>().Int32Value();
        numBands = metaObj.Get("numBands").As<Napi::Number>().Int32Value();

        Napi::Uint32Array bandOffsetsJs = metaObj.Get("bandOffsets").As<Napi::Uint32Array>();
        bandOffsets.assign(bandOffsetsJs.Data(), bandOffsetsJs.Data() + bandOffsetsJs.ElementLength());
        Napi::Uint32Array bandLengthsJs = metaObj.Get("bandLengths").As<Napi::Uint32Array>();
        bandLengths.assign(bandLengthsJs.Data(), bandLengthsJs.Data() + bandLengthsJs.ElementLength());
        Napi::Int32Array bandStepLog2sJs = metaObj.Get("bandStepLog2s").As<Napi::Int32Array>();
        bandStepLog2s.assign(bandStepLog2sJs.Data(), bandStepLog2sJs.Data() + bandStepLog2sJs.ElementLength());

        bandsPerOctave = paramsJs.Get("bandsPerOctave").As<Napi::Number>().Int32Value();
        fminHz = paramsJs.Get("minFreq").As<Napi::Number>().DoubleValue();

        detectOnsets = paramsJs.Has("detectOnsets") && paramsJs.Get("detectOnsets").ToBoolean().Value();
        if (detectOnsets && paramsJs.Has("onsetStartSec") && paramsJs.Has("onsetEndSec"))
        {
            onsetRegion.startSec = paramsJs.Get("onsetStartSec").ToNumber().DoubleValue();
            onsetRegion.endSec = paramsJs.Get("onsetEndSec").ToNumber().DoubleValue();
            onsetRegion.odfReference =
                paramsJs.Has("onsetOdfReference") ? paramsJs.Get("onsetOdfReference").ToNumber().DoubleValue() : 0.0;
            if (paramsJs.Has("onsetBandMax") && paramsJs.Get("onsetBandMax").IsTypedArray())
            {
                Napi::Float32Array bm = paramsJs.Get("onsetBandMax").As<Napi::Float32Array>();
                onsetBandMaxIn.assign(bm.Data(), bm.Data() + bm.ElementLength());
                onsetRegion.bandMaxReference = onsetBandMaxIn.data();
                onsetRegion.bandMaxCount = (int)onsetBandMaxIn.size();
            }
            hasOnsetRegion = true;
        }

        if (existingAudioJs.Length() > 0)
        {
            const uint32_t len = existingAudioJs.Length();
            existingAudio.reserve(len);
            existingAudioLens.reserve(len);
            existingAudioRefs.reserve(len);
            for (uint32_t i = 0; i < len; i++)
            {
                Napi::Float32Array channelJs = existingAudioJs.Get(i).As<Napi::Float32Array>();
                existingAudioRefs.push_back(Napi::Reference<Napi::Float32Array>::New(channelJs, 1));
                existingAudio.push_back(channelJs.Data());
                existingAudioLens.push_back(channelJs.ElementLength());
            }
        }

        winStartFrame = windowObj.Get("startFrame").As<Napi::Number>().Int64Value();
        winEndFrame = windowObj.Get("endFrame").As<Napi::Number>().Int64Value();
        winStartBand = windowObj.Get("startBand").As<Napi::Number>().Int32Value();
        winEndBand = windowObj.Get("endBand").As<Napi::Number>().Int32Value();

        footStart = strokeObj.Get("footStartFrame").As<Napi::Number>().Int64Value();
        footEnd = strokeObj.Get("footEndFrame").As<Napi::Number>().Int64Value();
        hardEdgeStart = strokeObj.Get("hardEdgeStart").ToBoolean().Value();
        hardEdgeEnd = strokeObj.Get("hardEdgeEnd").ToBoolean().Value();
        applyLimiter = strokeObj.Get("applyLimiter").ToBoolean().Value();
        if (strokeObj.Has("project"))
            projectEnabled = strokeObj.Get("project").ToBoolean().Value();
    }

    void Execute()
    {
        if (!validate())
            return;

        const double fminFrac = fminHz / sampleRate;
        gaborator::log_fq_scale scale(bandsPerOctave, fminFrac);
        gaborator::parameters params(scale, OVERLAP);
        params.phase = gaborator::coef_phase::global;
        gaborator::analyzer<float> analyzer(params);
        const int bandBegin = analyzer.bandpass_bands_begin();
        const int bandEnd = analyzer.bandpass_bands_end();

        const PackedCoefs src{packed, packedLen, bandOffsets.data(), bandLengths.data(), bandStepLog2s.data(),
                              numBands};

        const bool partial = !existingAudio.empty() && winStartFrame >= 0 && winEndFrame > winStartFrame;

        // The window the audio is rebuilt over: the painted span plus the reach
        // of the widest synthesis filter it touched.
        int64_t support;
        if (partial && winStartBand >= 0 && winEndBand > winStartBand)
        {
            double maxSupport = 0.0;
            const int b0 = std::max(0, (int)winStartBand);
            const int b1 = std::min(numBands, (int)winEndBand);
            for (int b = b0; b < b1; ++b)
                maxSupport = std::max(maxSupport, analyzer.band_synthesis_support(b + bandBegin));
            support = (int64_t)std::ceil(maxSupport);
        }
        else
        {
            support = (int64_t)std::ceil(analyzer.synthesis_support());
        }
        support = std::min(support, (int64_t)(sampleRate * 0.1));

        const int64_t crossfadeSamples = (int64_t)(sampleRate * 0.01);
        // The gate rewrites from the window edge inward, so the window must
        // start clear of the splice's own ramp or the two would fight.
        support = std::max(support, crossfadeSamples);

        int64_t w0, w1;
        if (partial)
        {
            w0 = std::max<int64_t>(0, winStartFrame - support);
            w1 = std::min<int64_t>(numFrames, winEndFrame + support);
        }
        else
        {
            w0 = 0;
            w1 = numFrames;
        }
        if (w1 <= w0)
        {
            SetError("commitStroke: empty synthesis window");
            return;
        }

        int64_t fillStart = 0;
        int64_t fillEnd = numFrames;
        if (partial)
        {
            fillStart = std::max<int64_t>(0, w0 - support * 2);
            fillEnd = std::min<int64_t>(numFrames, w1 + support * 2);
        }

        // 1. Synthesize the window and splice it into the audio there was.
        audioChannels.resize(channels);
        {
            std::vector<float> synth((size_t)(w1 - w0));
            for (int ch = 0; ch < channels; ++ch)
            {
                gaborator::coefs<float> coefs(analyzer);
                fillCoefsFromPacked(src, ch, bandBegin, bandEnd, fillStart, fillEnd, coefs);
                analyzer.synthesize(coefs, w0, w1, synth.data());

                if (partial)
                {
                    audioChannels[ch].assign(existingAudio[ch], existingAudio[ch] + existingAudioLens[ch]);
                    crossfadeSpliceInto(audioChannels[ch], existingAudio[ch], synth, w0, w1, numFrames,
                                        crossfadeSamples);
                }
                else
                {
                    audioChannels[ch] = synth;
                }
            }
        }

        // 2. Hard time edges, made exact in the time domain.
        if (partial && (hardEdgeStart || hardEdgeEnd))
            applyHardEdges(analyzer, src, bandBegin, bandEnd, w0, w1, fillStart, fillEnd);

        // 3. Limiting, applied to the stroke's contribution so it belongs to
        //    the stroke rather than to the file.
        std::vector<float> weightedGain;
        if (applyLimiter)
            limitWindow(w0, w1, partial && hardEdgeStart && footStart > 0,
                        partial && hardEdgeEnd && footEnd < numFrames, weightedGain);

        // 4. Project the canvas through the audio. Skipped when the stroke
        //    keeps its painted coefficients; the patch then comes back empty.
        if (projectEnabled)
            project(analyzer, bandBegin, bandEnd, w0, w1);

        peakValue = 0.0f;
        for (const auto &channel : audioChannels)
            for (float sample : channel)
                peakValue = std::max(peakValue, std::abs(sample));

        // 5. Onsets, read through the patch so they answer to the projection
        //    rather than to the coefficients it replaced.
        if (detectOnsets)
        {
            OnsetBandLayout layout;
            layout.numBands = std::min<int>(numBands, (int)std::min(bandOffsets.size(),
                                                                    std::min(bandLengths.size(), bandStepLog2s.size())));
            layout.numChannels = channels;
            layout.bandOffsets = bandOffsets.data();
            layout.bandLengths = bandLengths.data();
            layout.bandStepLog2s = bandStepLog2s.data();

            OnsetPatchOverlay overlay;
            overlay.k0 = patchK0.data();
            overlay.count = patchCount.data();
            overlay.pixelBase = patchPixelBase.data();
            overlay.pixels = patchPixels.data();
            overlay.pixelFloats = patchPixels.size();

            onsets = computeOnsets(packed, packedLen, layout, numFrames, sampleRate,
                                   hasOnsetRegion ? &onsetRegion : nullptr, &onsetOdfMax, &onsetBandMaxOut,
                                   projectEnabled ? &overlay : nullptr);
        }

        // 6. Output levels over the window.
        computeLevels(w0, w1, weightedGain);
    }

    void OnOK()
    {
        Napi::Env env = Env();
        Napi::HandleScope scope(env);
        Napi::Object result = Napi::Object::New(env);

        Napi::Array outputChannels = Napi::Array::New(env, channels);
        for (int ch = 0; ch < channels; ++ch)
        {
            const size_t len = audioChannels[ch].size();
            Napi::Float32Array buffer = Napi::Float32Array::New(env, len);
            if (len)
                memcpy(buffer.Data(), audioChannels[ch].data(), len * sizeof(float));
            outputChannels[ch] = buffer;
        }
        result.Set("channels", outputChannels);
        result.Set("peak", Napi::Number::New(env, peakValue));

        Napi::Object patch = Napi::Object::New(env);
        const size_t n = rangeBands.size();
        Napi::Uint32Array ranges = Napi::Uint32Array::New(env, n * 3);
        for (size_t i = 0; i < n; ++i)
        {
            ranges[i * 3 + 0] = rangeBands[i];
            ranges[i * 3 + 1] = rangeStarts[i];
            ranges[i * 3 + 2] = rangeCounts[i];
        }
        Napi::Float32Array pixels = Napi::Float32Array::New(env, patchPixels.size());
        if (!patchPixels.empty())
            memcpy(pixels.Data(), patchPixels.data(), patchPixels.size() * sizeof(float));
        patch.Set("ranges", ranges);
        patch.Set("pixels", pixels);
        result.Set("patch", patch);

        Napi::Float32Array grBuffer = Napi::Float32Array::New(env, gainReductionDb.size());
        if (!gainReductionDb.empty())
            memcpy(grBuffer.Data(), gainReductionDb.data(), gainReductionDb.size() * sizeof(float));
        result.Set("gainReductionDb", grBuffer);
        result.Set("maxGainReductionDb", Napi::Number::New(env, maxGainReductionDb));

        Napi::Object levels = Napi::Object::New(env);
        levels.Set("startHop", Napi::Number::New(env, (double)levelStartHop));
        Napi::Float32Array peaksJs = Napi::Float32Array::New(env, levelPeaks.size());
        if (!levelPeaks.empty())
            memcpy(peaksJs.Data(), levelPeaks.data(), levelPeaks.size() * sizeof(float));
        levels.Set("peaks", peaksJs);
        Napi::Float32Array overDbJs = Napi::Float32Array::New(env, levelOverDb.size());
        if (!levelOverDb.empty())
            memcpy(overDbJs.Data(), levelOverDb.data(), levelOverDb.size() * sizeof(float));
        levels.Set("overDb", overDbJs);
        result.Set("levels", levels);

        if (detectOnsets)
        {
            result.Set("onsets", OnsetWorker::packOnsets(env, onsets));
            result.Set("onsetOdfMax", Napi::Number::New(env, onsetOdfMax));
            result.Set("onsetBandMax", OnsetWorker::packBandMax(env, onsetBandMaxOut));
        }

        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e) { deferred.Reject(e.Value()); }
    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    /** Any violation fails the whole commit: a partial result has no meaning. */
    bool validate()
    {
        if (channels <= 0 || numBands <= 0 || numFrames <= 0 || sampleRate <= 0.0)
        {
            SetError("commitStroke: numChannels, numBands, numFrames and sampleRate must all be positive");
            return false;
        }
        if ((int)bandOffsets.size() < numBands || (int)bandLengths.size() < numBands ||
            (int)bandStepLog2s.size() < numBands)
        {
            SetError("commitStroke: band tables are shorter than numBands");
            return false;
        }
        for (int b = 0; b < numBands; ++b)
        {
            const size_t end = (size_t)bandOffsets[b] + (size_t)bandLengths[b];
            if (end * 4 > packedLen)
            {
                SetError("commitStroke: band layout runs past the end of the packed buffer");
                return false;
            }
        }
        if (!existingAudio.empty())
        {
            if ((int)existingAudio.size() != channels)
            {
                SetError("commitStroke: existingAudio has a different channel count from the analysis");
                return false;
            }
            for (size_t i = 0; i < existingAudioLens.size(); ++i)
            {
                if ((int64_t)existingAudioLens[i] != numFrames)
                {
                    SetError("commitStroke: existingAudio channel length does not match numFrames");
                    return false;
                }
            }
        }
        if (footEnd > footStart && (footStart < 0 || footEnd > numFrames))
        {
            SetError("commitStroke: stroke footprint falls outside the file");
            return false;
        }
        return true;
    }

    /**
     * A hard-edged stroke changes the audio inside its own time span and
     * nowhere else. Outside the span the audio that was there goes back — that
     * is the definition, and it is exact. Inside it, the atoms that live
     * outside still ring in across the edge, so their stem is synthesized and
     * subtracted; without that, an erase keeps an audible pre-tail before the
     * audio comes back and a tail after it cuts.
     */
    void applyHardEdges(gaborator::analyzer<float> &analyzer, const PackedCoefs &src, int bandBegin, int bandEnd,
                        int64_t w0, int64_t w1, int64_t fillStart, int64_t fillEnd)
    {
        const int64_t f0 = std::max(w0, footStart);
        const int64_t f1 = std::min(w1, footEnd);
        if (f1 <= f0)
            return;

        const int bandLo = std::max(0, (int)winStartBand);
        const int bandHi = std::min(numBands - 1, (int)winEndBand - 1);
        if (bandLo > bandHi)
            return;

        const bool gateStart = hardEdgeStart && footStart > 0;
        const bool gateEnd = hardEdgeEnd && footEnd < numFrames;
        if (!gateStart && !gateEnd)
            return;

        for (int ch = 0; ch < channels; ++ch)
        {
            // The stem reads the same coefficient range the synthesis read, so
            // what it subtracts is exactly what the synthesis put in.
            gaborator::coefs<float> exterior(analyzer);
            gaborator::fill(
                [&](int b, int64_t t, std::complex<float> &coef)
                {
                    coef = {0.0f, 0.0f};
                    const int bi = b - bandBegin;
                    if (bi < bandLo || bi > bandHi)
                        return;
                    if (t >= footStart && t < footEnd)
                        return;
                    const int64_t k = t >> src.bandStepLog2s[bi];
                    if (k < 0 || (size_t)k >= (size_t)src.bandLengths[bi])
                        return;
                    const size_t off = ((size_t)src.bandOffsets[bi] + (size_t)k) * 4 + (size_t)ch * 2;
                    if (off + 1 >= src.len)
                        return;
                    const float mag = src.data[off];
                    const float ph = src.data[off + 1];
                    coef = {mag * std::cos(ph), mag * std::sin(ph)};
                },
                bandBegin, bandEnd, fillStart, fillEnd, exterior);

            std::vector<float> ringIn((size_t)(f1 - f0));
            analyzer.synthesize(exterior, f0, f1, ringIn.data());
            for (int64_t t = f0; t < f1; ++t)
                audioChannels[ch][(size_t)t] -= ringIn[(size_t)(t - f0)];

            if (gateStart)
                for (int64_t t = w0; t < f0; ++t)
                    audioChannels[ch][(size_t)t] = existingAudio[ch][t];
            if (gateEnd)
                for (int64_t t = f1; t < w1; ++t)
                    audioChannels[ch][(size_t)t] = existingAudio[ch][t];
        }
    }

    /**
     * Limits inside the stroke and nowhere else. The gain is applied to the
     * stroke's contribution, not to the mix: out = g*mix + (1-g)*(1-w)*ex,
     * where w is a footprint mask that is 1 inside the stroke and 0 at and
     * beyond its in-file time edges. Outside the footprint (w = 0) that is
     * ex + g*(mix - ex): where the mix equals the existing audio the gain has
     * nothing to act on, so the limiter's attack and release skirts leave the
     * surroundings bit-exact — no ducking, no step. The per-sample ceiling is
     * the global ceiling or the existing audio's own held true peak, whichever
     * is higher, so a stroke into already-hot audio is held to the loudness
     * that was there instead of being cancelled. weightedGain gets the gain
     * the footprint hears (unity outside it), which is what the meter shows.
     *
     * gatedStart/gatedEnd say the hard-edge gate rewrote the audio outside
     * that edge to the existing samples exactly.
     */
    void limitWindow(int64_t w0, int64_t w1, bool gatedStart, bool gatedEnd, std::vector<float> &weightedGain)
    {
        const size_t n = (size_t)(w1 - w0);
        if (!n)
            return;

        std::vector<std::vector<float>> mixWin((size_t)channels), exWin((size_t)channels);
        for (int ch = 0; ch < channels; ++ch)
        {
            mixWin[(size_t)ch].assign(audioChannels[ch].begin() + w0, audioChannels[ch].begin() + w1);
            if (!existingAudio.empty())
                exWin[(size_t)ch].assign(existingAudio[ch] + w0, existingAudio[ch] + w1);
            else
                exWin[(size_t)ch].assign(n, 0.0f);
        }

        const std::vector<float> mixPeak = truePeakPerSample(mixWin);
        // The existing audio's loudness, held over the limiter's hold window
        // so its zero crossings do not read as headroom.
        const int holdSamples = (int)std::max(0.0, sampleRate * 0.040);
        const std::vector<float> exLoud = slidingMax(truePeakPerSample(exWin), holdSamples);

        // Footprint mask: 0 at and past each in-file time edge. A soft edge
        // raised-cosines up to 1 over the first rampSamples inside, keeping
        // the taper's hand-back continuous. A gated hard edge takes no ramp:
        // the audio outside it is the existing samples exactly, so the mask
        // may step where the content itself steps. An edge at the file
        // boundary has no outside to protect and stays at 1, and no footprint
        // at all means the whole window is the stroke.
        const float rampSamples = std::max(1.0f, (float)std::lround(sampleRate * 0.010));
        std::vector<float> mask(n, 1.0f);
        if (footEnd > footStart)
        {
            for (size_t i = 0; i < n; ++i)
            {
                const int64_t t = w0 + (int64_t)i;
                if (t < footStart || t >= footEnd)
                {
                    mask[i] = 0.0f;
                    continue;
                }
                const float dS = (footStart > 0 && !gatedStart) ? (float)(t - footStart) : rampSamples;
                const float dE = (footEnd < numFrames && !gatedEnd) ? (float)(footEnd - 1 - t) : rampSamples;
                const float u = std::min(1.0f, std::min(dS, dE) / rampSamples);
                mask[i] = u * u * (3.0f - 2.0f * u);
            }
        }

        // Required gain per sample: bring the mix down to the ceiling. Where
        // the mask is 1 that bounds the output exactly. Over a soft edge's
        // ramp the unscaled share of the existing audio can carry the output
        // at most (1-w)*(1-g)*exLoud past it — but a soft stroke tapers to
        // nothing at its edge, so where that share is large the stroke is
        // quiet and the bound is slack anyway.
        std::vector<float> gain(n, 1.0f);
        for (size_t i = 0; i < n; ++i)
        {
            const float ceiling = std::max(LIMITER_CEILING, exLoud[i]);
            if (mixPeak[i] > ceiling)
                gain[i] = ceiling / mixPeak[i];
        }
        smoothLimiterGain(gain, sampleRate, 40.0f, 200.0f);

        weightedGain.assign(n, 1.0f);
        for (size_t i = 0; i < n; ++i)
        {
            const float g = gain[i];
            if (g >= 1.0f)
                continue;
            const float w = mask[i];
            for (int ch = 0; ch < channels; ++ch)
            {
                const float ex = exWin[(size_t)ch][i];
                const float mix = mixWin[(size_t)ch][i];
                // = g*mix + (1-g)*(1-w)*ex, written so mix == ex passes ex
                // through bit-exact when w is 0.
                audioChannels[ch][(size_t)(w0 + (int64_t)i)] = ex + g * (mix - ex) - w * (1.0f - g) * ex;
            }
            weightedGain[i] = 1.0f + (g - 1.0f) * w;
        }
    }

    /**
     * Re-analyzes the finished audio and hands back the coefficients it reads
     * as, over every band. A band is rewritten only where its own filter can
     * see the changed audio; the analysis runs over twice that margin so those
     * coefficients are complete.
     *
     * Phase is written on the branch the packed format keeps — unwrapped
     * forward in time from the coefficient before the patch. A nearest-turn
     * write per coefficient would let neighbours land on different turns
     * wherever the stroke moved a phase by more than pi, and the transform
     * reads the difference between neighbours as pitch.
     */
    void project(gaborator::analyzer<float> &analyzer, int bandBegin, int bandEnd, int64_t w0, int64_t w1)
    {
        const int64_t marginCap = (int64_t)(sampleRate * COMMIT_MAX_ANALYSIS_MARGIN_SEC);
        std::vector<int64_t> bandMargin((size_t)numBands, 0);
        int64_t marginMax = 0;
        for (int b = 0; b < numBands; ++b)
        {
            int64_t m = (int64_t)std::ceil(analyzer.band_analysis_support(b + bandBegin));
            m = std::min(m, marginCap);
            bandMargin[(size_t)b] = m;
            marginMax = std::max(marginMax, m);
        }

        const int64_t a0 = std::max<int64_t>(0, w0 - 2 * marginMax);
        const int64_t a1 = std::min<int64_t>(numFrames, w1 + 2 * marginMax);

        patchK0.assign((size_t)numBands, 0);
        patchCount.assign((size_t)numBands, 0);
        patchPixelBase.assign((size_t)numBands, 0);
        for (int b = 0; b < numBands; ++b)
        {
            const int32_t step = bandStepLog2s[(size_t)b];
            const int64_t len = (int64_t)bandLengths[(size_t)b];
            if (len <= 0)
                continue;
            const int64_t k0 = std::max<int64_t>(0, (w0 - bandMargin[(size_t)b]) >> step);
            const int64_t k1 = std::min<int64_t>(len - 1, (w1 + bandMargin[(size_t)b] - 1) >> step);
            if (k1 < k0)
                continue;
            patchK0[(size_t)b] = k0;
            patchCount[(size_t)b] = k1 - k0 + 1;
        }

        // Harvest per band, then unwrap in time order — process() gives no
        // ordering, and the branch of one coefficient depends on the one before.
        std::vector<std::vector<float>> bandMag((size_t)numBands), bandPhase((size_t)numBands);
        for (int b = 0; b < numBands; ++b)
        {
            const size_t count = (size_t)patchCount[(size_t)b];
            if (!count)
                continue;
            bandMag[(size_t)b].assign(count * (size_t)channels, 0.0f);
            bandPhase[(size_t)b].assign(count * (size_t)channels, 0.0f);
        }

        std::vector<std::complex<float>> harvest;
        std::vector<uint8_t> needsTail((size_t)numBands, 0);
        for (int ch = 0; ch < channels; ++ch)
        {
            gaborator::coefs<float> coefs(analyzer);
            analyzer.analyze(audioChannels[ch].data() + a0, a0, a1, coefs);

            for (int b = 0; b < numBands; ++b)
            {
                const size_t count = (size_t)patchCount[(size_t)b];
                if (!count)
                    continue;
                harvest.assign(count, {0.0f, 0.0f});
                const int32_t step = bandStepLog2s[(size_t)b];
                const int64_t k0 = patchK0[(size_t)b];
                gaborator::process(
                    [&](int gb, int64_t t, std::complex<float> &coef)
                    {
                        if (gb - bandBegin != b)
                            return;
                        const int64_t rel = (t >> step) - k0;
                        if (rel < 0 || rel >= (int64_t)count)
                            return;
                        harvest[(size_t)rel] = coef;
                    },
                    bandBegin + b, bandBegin + b + 1, a0, a1, coefs);

                // Anchored on the coefficient before the patch, so the branch
                // continues the one already stored.
                float prev = 0.0f;
                bool havePrev = false;
                if (k0 > 0)
                {
                    const size_t off = ((size_t)bandOffsets[(size_t)b] + (size_t)(k0 - 1)) * 4 + (size_t)ch * 2;
                    if (off + 1 < packedLen)
                    {
                        prev = packed[off + 1];
                        havePrev = true;
                    }
                }
                for (size_t rel = 0; rel < count; ++rel)
                {
                    const std::complex<float> v = harvest[rel];
                    const float mag = std::abs(v);
                    const float raw = std::arg(v);
                    const float unwrapped = havePrev ? unwrapForward(raw, prev) : raw;
                    prev = unwrapped;
                    havePrev = true;
                    bandMag[(size_t)b][rel * (size_t)channels + (size_t)ch] = mag;
                    bandPhase[(size_t)b][rel * (size_t)channels + (size_t)ch] = unwrapped;
                }

                // The coefficient after the patch was unwrapped against the one
                // the patch replaced. If it no longer follows on from the new
                // value, the rest of the band has to be re-unwrapped, or the
                // transform reads the jump at the seam as pitch.
                const int64_t k1 = k0 + (int64_t)count - 1;
                if (k1 + 1 < (int64_t)bandLengths[(size_t)b])
                {
                    const size_t nextOff = ((size_t)bandOffsets[(size_t)b] + (size_t)(k1 + 1)) * 4 + (size_t)ch * 2;
                    if (nextOff + 1 < packedLen)
                    {
                        const float stored = packed[nextOff + 1];
                        const float rebranched = unwrapForward(stored, prev);
                        if (std::abs(rebranched - stored) > 1.0f)
                            needsTail[(size_t)b] = 1;
                    }
                }
            }
        }

        // Assemble the patch, extending any band whose branch moved.
        rangeBands.clear();
        rangeStarts.clear();
        rangeCounts.clear();
        patchPixels.clear();
        for (int b = 0; b < numBands; ++b)
        {
            const size_t count = (size_t)patchCount[(size_t)b];
            if (!count)
                continue;
            const int64_t k0 = patchK0[(size_t)b];
            const int64_t len = (int64_t)bandLengths[(size_t)b];

            const size_t total = needsTail[(size_t)b] ? (size_t)(len - k0) : count;

            patchPixelBase[(size_t)b] = patchPixels.size();
            patchCount[(size_t)b] = (int64_t)total;
            rangeBands.push_back((uint32_t)b);
            rangeStarts.push_back((uint32_t)k0);
            rangeCounts.push_back((uint32_t)total);

            std::vector<float> tailPrev((size_t)channels, 0.0f);
            for (int ch = 0; ch < channels; ++ch)
                tailPrev[(size_t)ch] = bandPhase[(size_t)b][(count - 1) * (size_t)channels + (size_t)ch];

            const size_t base = patchPixels.size();
            patchPixels.resize(base + total * 4, 0.0f);
            for (size_t rel = 0; rel < total; ++rel)
            {
                float *out = patchPixels.data() + base + rel * 4;
                if (rel < count)
                {
                    for (int ch = 0; ch < channels; ++ch)
                    {
                        out[ch * 2] = bandMag[(size_t)b][rel * (size_t)channels + (size_t)ch];
                        out[ch * 2 + 1] = bandPhase[(size_t)b][rel * (size_t)channels + (size_t)ch];
                    }
                    continue;
                }
                // Past the re-analyzed span the magnitudes stand, but the phases
                // are put back on the branch the new values ended on.
                const size_t srcOff = ((size_t)bandOffsets[(size_t)b] + (size_t)k0 + rel) * 4;
                if (srcOff + 3 >= packedLen)
                    continue;
                for (int ch = 0; ch < channels; ++ch)
                {
                    const float rebranched =
                        unwrapForward(packed[srcOff + (size_t)ch * 2 + 1], tailPrev[(size_t)ch]);
                    tailPrev[(size_t)ch] = rebranched;
                    out[ch * 2] = packed[srcOff + (size_t)ch * 2];
                    out[ch * 2 + 1] = rebranched;
                }
            }
        }
    }

    int64_t levelHopSamples() const
    {
        return std::max<int64_t>(1, std::lround(sampleRate * COMMIT_LEVEL_HOP_SEC));
    }

    /**
     * Peak level per 5 ms slice over the window, and how far the samples pass
     * full scale beyond the round trip's own ripple — measured the same with
     * the limiter engaged or bypassed. The limiter's reduction goes to
     * gainReductionDb alongside, not into the levels.
     */
    void computeLevels(int64_t w0, int64_t w1, const std::vector<float> &weightedGain)
    {
        const int64_t hop = levelHopSamples();
        levelStartHop = w0 / hop;
        const int64_t lastHop = (w1 - 1) / hop;
        const size_t points = (size_t)std::max<int64_t>(0, lastHop - levelStartHop + 1);
        levelPeaks.assign(points, 0.0f);
        levelOverDb.assign(points, 0.0f);
        gainReductionDb.assign(points, 0.0f);
        maxGainReductionDb = 0.0f;

        for (size_t p = 0; p < points; ++p)
        {
            const int64_t s0 = (levelStartHop + (int64_t)p) * hop;
            const int64_t s1 = std::min<int64_t>(numFrames, s0 + hop);
            float peak = 0.0f;
            for (int ch = 0; ch < channels; ++ch)
                for (int64_t i = s0; i < s1; ++i)
                    peak = std::max(peak, std::abs(audioChannels[ch][(size_t)i]));
            levelPeaks[p] = peak;

            if (!weightedGain.empty())
            {
                float lowest = 1.0f;
                for (int64_t i = std::max(s0, w0); i < std::min(s1, w1); ++i)
                    lowest = std::min(lowest, weightedGain[(size_t)(i - w0)]);
                const float db = lowest < 1.0f ? -20.0f * std::log10(lowest) : 0.0f;
                gainReductionDb[p] = db;
                maxGainReductionDb = std::max(maxGainReductionDb, db);
            }

            if (peak > 1.0f)
            {
                const float db = 20.0f * std::log10(peak);
                if (db > COMMIT_OVER_TOLERANCE_DB)
                    levelOverDb[p] = db - COMMIT_OVER_TOLERANCE_DB;
            }
        }
    }

    Napi::Promise::Deferred deferred;

    Napi::Reference<Napi::Float32Array> packedRef;
    const float *packed = nullptr;
    size_t packedLen = 0;

    double sampleRate;
    int64_t numFrames = 0;
    int channels = 1;
    int numBands = 0;
    std::vector<uint32_t> bandOffsets;
    std::vector<uint32_t> bandLengths;
    std::vector<int32_t> bandStepLog2s;
    int bandsPerOctave = 0;
    double fminHz = 0.0;

    bool detectOnsets = false;
    OnsetRegion onsetRegion{0.0, 0.0, 0.0, nullptr, 0};
    bool hasOnsetRegion = false;
    std::vector<float> onsetBandMaxIn;

    std::vector<Napi::Reference<Napi::Float32Array>> existingAudioRefs;
    std::vector<const float *> existingAudio;
    std::vector<size_t> existingAudioLens;

    int64_t winStartFrame = -1, winEndFrame = -1;
    int32_t winStartBand = -1, winEndBand = -1;
    int64_t footStart = 0, footEnd = 0;
    bool hardEdgeStart = false, hardEdgeEnd = false;
    bool applyLimiter = false;
    bool projectEnabled = true;

    // Results
    std::vector<std::vector<float>> audioChannels;
    float peakValue = 0.0f;
    std::vector<uint32_t> rangeBands, rangeStarts, rangeCounts;
    std::vector<float> patchPixels;
    std::vector<int64_t> patchK0, patchCount;
    std::vector<size_t> patchPixelBase;
    std::vector<float> gainReductionDb;
    float maxGainReductionDb = 0.0f;
    int64_t levelStartHop = 0;
    std::vector<float> levelPeaks;
    std::vector<float> levelOverDb;
    std::vector<DetectedOnset> onsets;
    std::vector<float> onsetBandMaxOut;
    double onsetOdfMax = 0.0;
};

Napi::Value CommitStrokeAsync(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 7 || !info[0].IsTypedArray() || !info[1].IsObject() || !info[2].IsNumber() ||
        !info[3].IsObject() || !info[4].IsArray() || !info[5].IsObject() || !info[6].IsObject())
    {
        Napi::TypeError::New(env, "Expected: packedData (Float32Array), analysisMetadata (Object), sampleRate "
                                  "(Number), params (Object), existingAudio (Array), window (Object), stroke (Object)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    auto *worker = new CommitStrokeWorker(env, info[0].As<Napi::Float32Array>(), info[1].As<Napi::Object>(),
                                          info[2].As<Napi::Number>().DoubleValue(), info[3].As<Napi::Object>(),
                                          info[4].As<Napi::Array>(), info[5].As<Napi::Object>(),
                                          info[6].As<Napi::Object>());
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

// ─── NMF separation ──────────────────────────────────────────────────────────
//
// Factorises the magnitude spectrogram as V ≈ W·H, where W holds `numComponents`
// spectral templates and H their activations over time, then turns each
// component's reconstruction into a Wiener soft mask. Like HPSS the masks are
// applied to the magnitude channels only and sum to 1 across components, so the
// parts add back up to the input — phase channels are copied through untouched.
//
// Gaborator's layout is multirate (each band has its own frame count), so the
// factorisation runs on a rectangular matrix built by resampling every band onto
// a shared normalised time grid. Masks are then evaluated at each band's native
// rate by interpolating H, which keeps the fit cheap without losing resolution
// in the output.

// Longest band length used for the fit grid. Beyond this the extra temporal
// detail costs iterations without changing the templates meaningfully.
#define NMF_MAX_FIT_FRAMES 2048

// Deterministic PRNG (LCG) so a given seed always yields the same factorisation.
static inline float nmfRandom(uint32_t &state)
{
    state = state * 1664525u + 1013904223u;
    return (float)((state >> 8) & 0xFFFFFFu) / (float)0x1000000;
}

class NmfWorker : public Napi::AsyncWorker
{
public:
    NmfWorker(Napi::Env env,
              Napi::Float32Array packedDataJs,
              Napi::Object metaJs,
              int numComponents, int iterations, uint32_t seed)
        : Napi::AsyncWorker(env),
          deferred(Napi::Promise::Deferred::New(env)),
          numComponents(numComponents), iterations(iterations), seed(seed)
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
        const float eps = 1e-10f;
        const int K = numComponents;

        int maxLen = 0;
        for (int b = 0; b < numBands; ++b)
            maxLen = std::max(maxLen, (int)bandLengths[b]);
        const int T = std::max(1, std::min(maxLen, NMF_MAX_FIT_FRAMES));

        // V [numBands × T]: magnitudes summed over channels so one factorisation
        // describes both, keeping component k the same sound in left and right.
        std::vector<float> V((size_t)numBands * T, 0.0f);
        for (int b = 0; b < numBands; ++b)
        {
            const int L = (int)bandLengths[b];
            for (int t = 0; t < T; ++t)
            {
                const float normTime = (T > 1) ? (float)t / (float)(T - 1) : 0.0f;
                const int st = (L > 1)
                                   ? std::min((int)std::lround(normTime * (float)(L - 1)), L - 1)
                                   : 0;
                float sum = 0.0f;
                for (int ch = 0; ch < numChannels; ++ch)
                    sum += packedData[((size_t)bandOffsets[b] + st) * floatsPerPixel + ch * 2];
                V[(size_t)b * T + t] = sum;
            }
        }

        uint32_t rng = seed ? seed : 1u;
        std::vector<float> W((size_t)numBands * K), H((size_t)K * T);
        for (auto &w : W) w = nmfRandom(rng) * 0.9f + 0.1f;
        for (auto &h : H) h = nmfRandom(rng) * 0.9f + 0.1f;

        std::vector<float> WH((size_t)numBands * T);
        std::vector<float> ratio((size_t)numBands * T);
        std::vector<float> hAcc((size_t)K * T);
        std::vector<float> hSum(K), wSum(K);

        // Multiplicative updates for the KL divergence, which tracks the wide
        // dynamic range of a constant-Q magnitude spectrum better than the
        // Euclidean variant does.
        for (int it = 0; it < iterations; ++it)
        {
            for (int b = 0; b < numBands; ++b)
            {
                float *out = &WH[(size_t)b * T];
                std::fill(out, out + T, 0.0f);
                for (int k = 0; k < K; ++k)
                {
                    const float w = W[(size_t)b * K + k];
                    if (w <= 0.0f) continue;
                    const float *hrow = &H[(size_t)k * T];
                    for (int t = 0; t < T; ++t) out[t] += w * hrow[t];
                }
            }
            for (size_t i = 0; i < WH.size(); ++i)
                ratio[i] = V[i] / (WH[i] + eps);

            // H ← H ⊙ (Wᵀ·ratio) / (Wᵀ·1)
            std::fill(hAcc.begin(), hAcc.end(), 0.0f);
            std::fill(wSum.begin(), wSum.end(), 0.0f);
            for (int b = 0; b < numBands; ++b)
            {
                const float *rrow = &ratio[(size_t)b * T];
                for (int k = 0; k < K; ++k)
                {
                    const float w = W[(size_t)b * K + k];
                    wSum[k] += w;
                    if (w <= 0.0f) continue;
                    float *arow = &hAcc[(size_t)k * T];
                    for (int t = 0; t < T; ++t) arow[t] += w * rrow[t];
                }
            }
            for (int k = 0; k < K; ++k)
            {
                float *hrow = &H[(size_t)k * T];
                const float *arow = &hAcc[(size_t)k * T];
                const float denom = wSum[k] + eps;
                for (int t = 0; t < T; ++t) hrow[t] *= arow[t] / denom;
            }

            // W ← W ⊙ (ratio·Hᵀ) / (1·Hᵀ), using the ratio from the same sweep;
            // recomputing WH between the two halves costs a full pass for a
            // convergence difference that isn't audible.
            for (int k = 0; k < K; ++k)
            {
                const float *hrow = &H[(size_t)k * T];
                float s = 0.0f;
                for (int t = 0; t < T; ++t) s += hrow[t];
                hSum[k] = s;
            }
            for (int b = 0; b < numBands; ++b)
            {
                const float *rrow = &ratio[(size_t)b * T];
                for (int k = 0; k < K; ++k)
                {
                    const float *hrow = &H[(size_t)k * T];
                    float s = 0.0f;
                    for (int t = 0; t < T; ++t) s += rrow[t] * hrow[t];
                    W[(size_t)b * K + k] *= s / (hSum[k] + eps);
                }
            }
        }

        // Normalise each template to unit sum, pushing the scale into its
        // activations so W·H is unchanged but the columns are comparable.
        for (int k = 0; k < K; ++k)
        {
            float colSum = 0.0f;
            for (int b = 0; b < numBands; ++b) colSum += W[(size_t)b * K + k];
            if (colSum <= eps) continue;
            for (int b = 0; b < numBands; ++b) W[(size_t)b * K + k] /= colSum;
            float *hrow = &H[(size_t)k * T];
            for (int t = 0; t < T; ++t) hrow[t] *= colSum;
        }

        // Order components by spectral centroid so part 1 is the lowest-pitched.
        // The factorisation itself has no canonical ordering, and low→high reads
        // naturally against the vertical spectrogram.
        std::vector<int> order(K);
        std::iota(order.begin(), order.end(), 0);
        std::vector<float> centroid(K, 0.0f);
        for (int k = 0; k < K; ++k)
        {
            float num = 0.0f, den = 0.0f;
            for (int b = 0; b < numBands; ++b)
            {
                const float w = W[(size_t)b * K + k];
                num += (float)b * w;
                den += w;
            }
            centroid[k] = (den > eps) ? num / den : 0.0f;
        }
        std::sort(order.begin(), order.end(),
                  [&](int a, int b) { return centroid[a] < centroid[b]; });

        // Wiener masks at each band's native frame rate, with H interpolated
        // back up from the fit grid. Phase channels stay as they are.
        parts.assign(K, packedData);
        std::vector<float> comp(K);
        for (int b = 0; b < numBands; ++b)
        {
            const int L = (int)bandLengths[b];
            for (int t = 0; t < L; ++t)
            {
                const float pos = (L > 1)
                                      ? ((float)t / (float)(L - 1)) * (float)(T - 1)
                                      : 0.0f;
                const int t0 = std::min((int)pos, T - 1);
                const int t1 = std::min(t0 + 1, T - 1);
                const float frac = pos - (float)t0;

                float total = 0.0f;
                for (int k = 0; k < K; ++k)
                {
                    const int src = order[k];
                    const float h = H[(size_t)src * T + t0] * (1.0f - frac) +
                                    H[(size_t)src * T + t1] * frac;
                    const float v = W[(size_t)b * K + src] * h;
                    comp[k] = v * v;
                    total += comp[k];
                }
                total += eps;

                for (int ch = 0; ch < numChannels; ++ch)
                {
                    const size_t fi = ((size_t)bandOffsets[b] + t) * floatsPerPixel + ch * 2;
                    const float mag = packedData[fi];
                    for (int k = 0; k < K; ++k)
                        parts[k][fi] = mag * (comp[k] / total);
                }
            }
        }
    }

    void OnOK() override
    {
        Napi::Env env = Env();
        Napi::Array partsJs = Napi::Array::New(env, parts.size());
        for (size_t k = 0; k < parts.size(); ++k)
        {
            Napi::Float32Array arr = Napi::Float32Array::New(env, parts[k].size());
            memcpy(arr.Data(), parts[k].data(), parts[k].size() * sizeof(float));
            partsJs[(uint32_t)k] = arr;
        }
        Napi::Object result = Napi::Object::New(env);
        result.Set("parts", partsJs);
        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }

private:
    Napi::Promise::Deferred deferred;
    std::vector<float> packedData;
    std::vector<std::vector<float>> parts;
    std::vector<uint32_t> bandOffsets, bandLengths;
    int numComponents, iterations;
    uint32_t seed;
    int numBands = 0, numChannels = 0;
};

Napi::Value NmfAsync(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsTypedArray() || !info[1].IsObject() || !info[2].IsNumber())
    {
        Napi::TypeError::New(env,
            "Expected (Float32Array packedData, Object meta, number numComponents[, number iterations, number seed])")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    const int numComponents = std::max(2, info[2].As<Napi::Number>().Int32Value());
    const int iterations = (info.Length() > 3 && info[3].IsNumber())
                               ? std::max(1, info[3].As<Napi::Number>().Int32Value())
                               : 120;
    const uint32_t seed = (info.Length() > 4 && info[4].IsNumber())
                              ? (uint32_t)info[4].As<Napi::Number>().Int64Value()
                              : 1u;

    auto *worker = new NmfWorker(env,
        info[0].As<Napi::Float32Array>(),
        info[1].As<Napi::Object>(),
        numComponents, iterations, seed);
    auto promise = worker->GetPromise();
    worker->Queue();
    return promise;
}

// ─── Spectrogram merge ───────────────────────────────────────────────────────
//
// Sums several spectrograms that share a band layout. The sum is taken on the
// complex coefficients, not the magnitudes: parts fresh out of a split share the
// input's phase and would add correctly either way, but once a part has been
// edited (the transform effect rewrites phase) magnitude addition overlaps
// incoherently and reads as too loud in the shared bins.

class MergeWorker : public Napi::AsyncWorker
{
public:
    MergeWorker(Napi::Env env, Napi::Array inputsJs, Napi::Object metaJs)
        : Napi::AsyncWorker(env),
          deferred(Napi::Promise::Deferred::New(env))
    {
        const uint32_t count = inputsJs.Length();
        inputs.resize(count);
        for (uint32_t i = 0; i < count; ++i)
        {
            Napi::Float32Array arr = inputsJs.Get(i).As<Napi::Float32Array>();
            inputs[i].assign(arr.Data(), arr.Data() + arr.ElementLength());
        }

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
        if (inputs.empty())
        {
            SetError("mergeSpectrograms needs at least one input");
            return;
        }
        const size_t len = inputs[0].size();
        for (const auto &in : inputs)
        {
            if (in.size() != len)
            {
                SetError("mergeSpectrograms inputs must all be the same length");
                return;
            }
        }

        const int floatsPerPixel = 4;
        merged.assign(len, 0.0f);

        for (int b = 0; b < numBands; ++b)
        {
            const int L = (int)bandLengths[b];
            for (int t = 0; t < L; ++t)
            {
                for (int ch = 0; ch < numChannels; ++ch)
                {
                    const size_t fi = ((size_t)bandOffsets[b] + t) * floatsPerPixel + ch * 2;
                    if (fi + 1 >= len) continue;

                    double re = 0.0, im = 0.0;
                    // The part contributing most of the magnitude decides which
                    // branch the result is expressed on.
                    float refPhase = inputs[0][fi + 1];
                    float bestMag = -1.0f;
                    for (const auto &in : inputs)
                    {
                        const float mag = in[fi];
                        const float phase = in[fi + 1];
                        re += (double)mag * std::cos((double)phase);
                        im += (double)mag * std::sin((double)phase);
                        if (mag > bestMag)
                        {
                            bestMag = mag;
                            refPhase = phase;
                        }
                    }

                    const double mag = std::sqrt(re * re + im * im);
                    merged[fi] = (float)mag;
                    if (mag > 0.0)
                    {
                        // analyze() unwraps phase along time and the transform
                        // effect's maths depends on that convention, so re-express
                        // the summed angle on the reference's branch rather than
                        // leaving it inside atan2's [-π, π]. Parts that still
                        // share a phase come back with it bit-for-bit.
                        const double raw = std::atan2(im, re);
                        const double delta = std::remainder(raw - (double)refPhase, 2.0 * M_PI);
                        merged[fi + 1] = (float)((double)refPhase + delta);
                    }
                    else
                    {
                        // A silent bin has no meaningful angle; keep the
                        // reference phase so the field stays continuous.
                        merged[fi + 1] = refPhase;
                    }
                }
            }
        }
    }

    void OnOK() override
    {
        Napi::Env env = Env();
        Napi::Float32Array arr = Napi::Float32Array::New(env, merged.size());
        memcpy(arr.Data(), merged.data(), merged.size() * sizeof(float));
        Napi::Object result = Napi::Object::New(env);
        result.Set("merged", arr);
        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }

private:
    Napi::Promise::Deferred deferred;
    std::vector<std::vector<float>> inputs;
    std::vector<float> merged;
    std::vector<uint32_t> bandOffsets, bandLengths;
    int numBands = 0, numChannels = 0;
};

Napi::Value MergeSpectrogramsAsync(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsObject())
    {
        Napi::TypeError::New(env, "Expected (Float32Array[] parts, Object meta)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    auto *worker = new MergeWorker(env, info[0].As<Napi::Array>(), info[1].As<Napi::Object>());
    auto promise = worker->GetPromise();
    worker->Queue();
    return promise;
}

// ─── AI Separation (via ONNX Runtime C++; not built for Intel macOS) ────────

#ifdef GABORATOR_ONNX_ENABLED
#include "vendor/onnxruntime/include/onnxruntime_cxx_api.h"
#include <map>
#include <mutex>
#include <memory>

static std::vector<float> aiLinearResample(const std::vector<float> &audio, double fromRate, double toRate)
{
    if (fromRate == toRate) return audio;
    double ratio = fromRate / toRate;
    size_t length = (size_t)std::round((double)audio.size() / ratio);
    std::vector<float> result(length);
    for (size_t i = 0; i < length; i++)
    {
        double pos = i * ratio;
        size_t idx = (size_t)pos;
        double frac = pos - idx;
        float a = idx < audio.size() ? audio[idx] : 0.0f;
        float b = idx + 1 < audio.size() ? audio[idx + 1] : 0.0f;
        result[i] = (float)(a + frac * (b - a));
    }
    return result;
}

static std::vector<float> makeTriangularWindow(int n)
{
    std::vector<float> w(n);
    double half = n / 2.0;
    for (int i = 0; i < n; i++)
        w[i] = (float)(i < (int)half ? (i + 1) / half : (n - i) / half);
    return w;
}

static Ort::Env &getOrtEnv()
{
    static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "noise_canvas");
    return env;
}

// ORTCHAR_T is wchar_t on Windows and char elsewhere, so paths cross the API in
// the platform's own encoding.
#ifdef _WIN32
static std::wstring toOrtPath(const std::string &path)
{
    if (path.empty()) return std::wstring();
    int length = MultiByteToWideChar(CP_UTF8, 0, path.data(), (int)path.size(), nullptr, 0);
    std::wstring wide((size_t)length, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, path.data(), (int)path.size(), wide.data(), length);
    return wide;
}
#else
static const std::string &toOrtPath(const std::string &path) { return path; }
#endif

struct CachedSession
{
    std::shared_ptr<Ort::Session> session;
    std::string inputName;
    std::string outputName;
};

static std::map<std::string, CachedSession> gSessionCache;
static std::mutex gSessionMutex;

static CachedSession getOrCreateSession(const std::string &modelPath)
{
    std::lock_guard<std::mutex> lock(gSessionMutex);
    auto it = gSessionCache.find(modelPath);
    if (it != gSessionCache.end()) return it->second;

    Ort::SessionOptions opts;
    opts.SetIntraOpNumThreads(4);
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_BASIC);
    opts.DisableMemPattern();
    opts.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);

    CachedSession cached;
    cached.session = std::make_shared<Ort::Session>(getOrtEnv(), toOrtPath(modelPath).c_str(), opts);

    Ort::AllocatorWithDefaultOptions allocator;
    cached.inputName  = cached.session->GetInputNameAllocated(0, allocator).get();
    cached.outputName = cached.session->GetOutputNameAllocated(0, allocator).get();

    gSessionCache[modelPath] = cached;
    return cached;
}

class AiSeparateWorker : public Napi::AsyncWorker
{
public:
    AiSeparateWorker(Napi::Env env,
                     std::vector<std::vector<float>> audioChannels,
                     double sampleRate,
                     std::string modelPath,
                     std::vector<std::string> stemNames)
        : Napi::AsyncWorker(env),
          deferred(Napi::Promise::Deferred::New(env)),
          audioChannels(std::move(audioChannels)),
          sampleRate(sampleRate),
          modelPath(std::move(modelPath)),
          stemNames(std::move(stemNames)) {}

    Napi::Promise GetPromise() { return deferred.Promise(); }

    void Execute() override
    {
        try { ExecuteImpl(); }
        catch (const Ort::Exception &e) { SetError(std::string("ORT error: ") + e.what()); }
        catch (const std::exception &e) { SetError(std::string("Error: ") + e.what()); }
        catch (...)                     { SetError("Unknown error during AI separation"); }
    }

    void ExecuteImpl()
    {
        const int    MODEL_RATE = 44100;
        const int    SEG        = 343980;
        const double OVERLAP_AI = 0.25;
        const int    stride     = (int)std::floor(SEG * (1.0 - OVERLAP_AI));

        auto resLeft  = aiLinearResample(audioChannels[0], sampleRate, MODEL_RATE);
        auto resRight = audioChannels.size() > 1
                        ? aiLinearResample(audioChannels[1], sampleRate, MODEL_RATE)
                        : resLeft;

        const int numSamples = (int)resLeft.size();
        const int numStems   = (int)stemNames.size();

        stems.resize(numStems);

        CachedSession cached = getOrCreateSession(modelPath);
        const char *inNames[]  = { cached.inputName.c_str() };
        const char *outNames[] = { cached.outputName.c_str() };
        auto memInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

        if (numSamples <= SEG)
        {
            // Model has SEG baked into an internal Reshape op, so pad input to
            // SEG and trim the output back to numSamples.
            std::vector<float> buf(2 * SEG, 0.0f);
            for (int i = 0; i < numSamples; i++)
            {
                buf[i]         = resLeft[i];
                buf[SEG + i]   = resRight[i];
            }
            const std::array<int64_t, 3> shape = {1, 2, SEG};
            Ort::Value tensor = Ort::Value::CreateTensor<float>(
                memInfo, buf.data(), buf.size(), shape.data(), shape.size());
            auto outputs = cached.session->Run(
                Ort::RunOptions{nullptr}, inNames, &tensor, 1, outNames, 1);
            const float *out = outputs[0].GetTensorData<float>();
            auto outShape = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
            const int outT = (outShape.size() >= 4) ? (int)outShape[3] : SEG;
            const int keep = std::min(numSamples, outT);
            for (int s = 0; s < numStems; s++)
            {
                std::vector<float> rawL(out + s * 2 * outT,         out + s * 2 * outT + keep);
                std::vector<float> rawR(out + s * 2 * outT + outT,  out + s * 2 * outT + outT + keep);
                stems[s].first  = aiLinearResample(rawL, MODEL_RATE, sampleRate);
                stems[s].second = aiLinearResample(rawR, MODEL_RATE, sampleRate);
            }
        }
        else
        {
            // Long file: overlap-add chunking with triangular window
            std::vector<std::vector<float>> accL(numStems, std::vector<float>(numSamples, 0.0f));
            std::vector<std::vector<float>> accR(numStems, std::vector<float>(numSamples, 0.0f));
            std::vector<float> weight(numSamples, 0.0f);
            auto window = makeTriangularWindow(SEG);

            std::vector<float> buf(2 * SEG);
            const std::array<int64_t, 3> shape = {1, 2, SEG};

            for (int start = 0; start < numSamples; start += stride)
            {
                int end    = std::min(start + SEG, numSamples);
                int segLen = end - start;

                std::fill(buf.begin(), buf.end(), 0.0f);
                for (int i = 0; i < segLen; i++)
                {
                    buf[i]       = resLeft[start + i];
                    buf[SEG + i] = resRight[start + i];
                }

                Ort::Value tensor = Ort::Value::CreateTensor<float>(
                    memInfo, buf.data(), buf.size(), shape.data(), shape.size());
                auto outputs = cached.session->Run(
                    Ort::RunOptions{nullptr}, inNames, &tensor, 1, outNames, 1);
                const float *out = outputs[0].GetTensorData<float>();
                auto outShape = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
                const int outT = (outShape.size() >= 4) ? (int)outShape[3] : SEG;

                for (int i = 0; i < segLen; i++)
                {
                    float w = window[i];
                    for (int s = 0; s < numStems; s++)
                    {
                        accL[s][start + i] += out[s * 2 * outT + i]        * w;
                        accR[s][start + i] += out[s * 2 * outT + outT + i]  * w;
                    }
                    weight[start + i] += w;
                }
            }

            for (int i = 0; i < numSamples; i++)
            {
                float w = weight[i];
                if (w > 0.0f)
                    for (int s = 0; s < numStems; s++)
                    {
                        accL[s][i] /= w;
                        accR[s][i] /= w;
                    }
            }

            for (int s = 0; s < numStems; s++)
            {
                stems[s].first  = aiLinearResample(accL[s], MODEL_RATE, sampleRate);
                stems[s].second = aiLinearResample(accR[s], MODEL_RATE, sampleRate);
            }
        } // end else (long file)
    } // end ExecuteImpl

    void OnOK() override
    {
        Napi::Env env = Env();
        Napi::Object result = Napi::Object::New(env);

        for (int s = 0; s < (int)stemNames.size(); s++)
        {
            Napi::Array ch = Napi::Array::New(env, 2);

            Napi::Float32Array l = Napi::Float32Array::New(env, stems[s].first.size());
            memcpy(l.Data(), stems[s].first.data(), stems[s].first.size() * sizeof(float));
            ch[0u] = l;

            Napi::Float32Array r = Napi::Float32Array::New(env, stems[s].second.size());
            memcpy(r.Data(), stems[s].second.data(), stems[s].second.size() * sizeof(float));
            ch[1u] = r;

            result.Set(stemNames[s], ch);
        }

        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }

private:
    Napi::Promise::Deferred deferred;
    std::vector<std::vector<float>> audioChannels;
    double sampleRate;
    std::string modelPath;
    std::vector<std::string> stemNames;
    std::vector<std::pair<std::vector<float>, std::vector<float>>> stems;
};

Napi::Value AiSeparateAsync(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 4 || !info[0].IsArray() || !info[1].IsNumber()
                          || !info[2].IsString() || !info[3].IsArray())
    {
        Napi::TypeError::New(env, "Expected (Float32Array[] channels, number sampleRate, string modelPath, string[] stemNames)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Array chJs       = info[0].As<Napi::Array>();
    double sampleRate      = info[1].As<Napi::Number>().DoubleValue();
    std::string modelPath  = info[2].As<Napi::String>().Utf8Value();
    Napi::Array stemNamesJs = info[3].As<Napi::Array>();

    std::vector<std::vector<float>> channels;
    for (uint32_t i = 0; i < chJs.Length(); i++)
    {
        Napi::Float32Array ch = chJs.Get(i).As<Napi::Float32Array>();
        channels.emplace_back(ch.Data(), ch.Data() + ch.ElementLength());
    }

    std::vector<std::string> stemNames;
    for (uint32_t i = 0; i < stemNamesJs.Length(); i++)
        stemNames.push_back(stemNamesJs.Get(i).As<Napi::String>().Utf8Value());

    auto *worker = new AiSeparateWorker(
        env, std::move(channels), sampleRate, std::move(modelPath), std::move(stemNames));
    worker->Queue();
    return worker->GetPromise();
}

#endif // GABORATOR_ONNX_ENABLED

// ─────────────────────────────────────────────────────────────────────────────

// Test hook: run the limiter on caller-supplied channels and return the result,
// so the exact limiter code can be exercised on controlled signals.
Napi::Value ApplyLimiterTest(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    Napi::Array channelsJs = info[0].As<Napi::Array>();
    double sampleRate = info[1].As<Napi::Number>().DoubleValue();

    const int channelCount = static_cast<int>(channelsJs.Length());
    std::vector<std::vector<float>> channels(channelCount);
    for (int ch = 0; ch < channelCount; ++ch)
    {
        Napi::Float32Array arr = channelsJs.Get(static_cast<uint32_t>(ch)).As<Napi::Float32Array>();
        channels[ch].assign(arr.Data(), arr.Data() + arr.ElementLength());
    }

    const float holdMs = info.Length() > 2 && info[2].IsNumber() ? info[2].As<Napi::Number>().FloatValue() : 40.0f;
    const float releaseMs = info.Length() > 3 && info[3].IsNumber() ? info[3].As<Napi::Number>().FloatValue() : 200.0f;
    applyLookaheadLimiter(channels, sampleRate, holdMs, releaseMs);

    Napi::Array out = Napi::Array::New(env, channelCount);
    for (int ch = 0; ch < channelCount; ++ch)
    {
        Napi::Float32Array arr = Napi::Float32Array::New(env, channels[ch].size());
        memcpy(arr.Data(), channels[ch].data(), channels[ch].size() * sizeof(float));
        out[static_cast<uint32_t>(ch)] = arr;
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Undo-history codec
//
// The history cache stores packed FBO states, which run to hundreds of megabytes
// on a multi-minute file. Everything here walks those buffers a value at a time,
// so it lives in the addon and runs on a worker thread: the same passes in the
// renderer's JS would stall painting for hundreds of milliseconds per stroke.
//
// zstd finds almost nothing in interleaved RGBA float32 — adjacent bytes belong
// to different channels (magnitude, phase) and to different positions within a
// mantissa. Reordering into per-channel planes and then per-byte-position planes
// groups the bytes that correlate, which is worth ~30% of the compressed size.
// The reordering is a permutation, so it is exactly lossless; the compression
// itself is left to the caller.

// Channels per pixel in the packed texture: [magL, phaseL, magR, phaseR].
static const size_t HISTORY_CHANNELS = 4;
static const size_t HISTORY_VALUE_BYTES = 4;

// Interleaved 32-bit values -> byte-position-major, then channel-major planes.
static void historyEncodePlanes(const uint8_t *src, size_t valueCount, uint8_t *out)
{
    const size_t pixels = valueCount / HISTORY_CHANNELS;
    const size_t planeStride = valueCount;
    for (size_t c = 0; c < HISTORY_CHANNELS; ++c)
    {
        const size_t planeBase = c * pixels;
        for (size_t i = 0; i < pixels; ++i)
        {
            const uint8_t *s = src + (i * HISTORY_CHANNELS + c) * HISTORY_VALUE_BYTES;
            const size_t d = planeBase + i;
            out[d] = s[0];
            out[planeStride + d] = s[1];
            out[2 * planeStride + d] = s[2];
            out[3 * planeStride + d] = s[3];
        }
    }
}

static void historyDecodePlanes(const uint8_t *src, size_t valueCount, uint8_t *out)
{
    const size_t pixels = valueCount / HISTORY_CHANNELS;
    const size_t planeStride = valueCount;
    for (size_t c = 0; c < HISTORY_CHANNELS; ++c)
    {
        const size_t planeBase = c * pixels;
        for (size_t i = 0; i < pixels; ++i)
        {
            uint8_t *d = out + (i * HISTORY_CHANNELS + c) * HISTORY_VALUE_BYTES;
            const size_t s = planeBase + i;
            d[0] = src[s];
            d[1] = src[planeStride + s];
            d[2] = src[2 * planeStride + s];
            d[3] = src[3 * planeStride + s];
        }
    }
}

// Holds a typed array alive across the async boundary and exposes its bytes.
// The caller must not mutate the array while the worker is in flight.
struct HistoryBufferRef
{
    Napi::Reference<Napi::Value> ref;
    const uint8_t *data = nullptr;
    size_t byteLength = 0;

    void hold(const Napi::Value &value)
    {
        ref = Napi::Reference<Napi::Value>::New(value, 1);
        Napi::ArrayBuffer buffer;
        size_t offset = 0;
        if (value.IsTypedArray())
        {
            Napi::TypedArray array = value.As<Napi::TypedArray>();
            buffer = array.ArrayBuffer();
            offset = array.ByteOffset();
            byteLength = array.ByteLength();
        }
        else
        {
            buffer = value.As<Napi::ArrayBuffer>();
            byteLength = buffer.ByteLength();
        }
        data = static_cast<const uint8_t *>(buffer.Data()) + offset;
    }
};

// Reorders a packed state into plane order, ready to be compressed.
class HistoryEncodePlanesWorker : public Napi::AsyncWorker
{
public:
    HistoryEncodePlanesWorker(Napi::Env env, const Napi::Value &input)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env))
    {
        source.hold(input);
    }

    void Execute() override
    {
        const size_t valueCount = source.byteLength / HISTORY_VALUE_BYTES;
        // Packed states are whole RGBA pixels; anything else would be silently
        // truncated by the plane split rather than round-tripping.
        if (source.byteLength % (HISTORY_CHANNELS * HISTORY_VALUE_BYTES) != 0)
        {
            SetError("history state is not a whole number of RGBA pixels");
            return;
        }
        out.resize(source.byteLength);
        if (!out.empty())
            historyEncodePlanes(source.data, valueCount, out.data());
    }

    void OnOK() override
    {
        Napi::HandleScope scope(Env());
        deferred.Resolve(Napi::Buffer<uint8_t>::Copy(Env(), out.data(), out.size()));
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }
    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    HistoryBufferRef source;
    std::vector<uint8_t> out;
};

// Restores a packed state from plane order.
class HistoryDecodePlanesWorker : public Napi::AsyncWorker
{
public:
    HistoryDecodePlanesWorker(Napi::Env env, const Napi::Value &input)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env))
    {
        source.hold(input);
    }

    void Execute() override
    {
        if (source.byteLength % (HISTORY_CHANNELS * HISTORY_VALUE_BYTES) != 0)
        {
            SetError("history state is not a whole number of RGBA pixels");
            return;
        }
        out.resize(source.byteLength);
        if (!out.empty())
            historyDecodePlanes(source.data, source.byteLength / HISTORY_VALUE_BYTES, out.data());
    }

    void OnOK() override
    {
        Napi::HandleScope scope(Env());
        Napi::Float32Array result = Napi::Float32Array::New(Env(), out.size() / HISTORY_VALUE_BYTES);
        memcpy(result.Data(), out.data(), out.size());
        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }
    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    HistoryBufferRef source;
    std::vector<uint8_t> out;
};

// True if any value inside the footprint ranges differs between base and after.
class HistoryFootprintChangedWorker : public Napi::AsyncWorker
{
public:
    HistoryFootprintChangedWorker(Napi::Env env, const Napi::Value &baseJs, const Napi::Value &afterJs,
                                  const Napi::Uint32Array &rangesJs)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env))
    {
        base.hold(baseJs);
        after.hold(afterJs);
        ranges.assign(rangesJs.Data(), rangesJs.Data() + rangesJs.ElementLength());
    }

    void Execute() override
    {
        const uint32_t *baseBits = reinterpret_cast<const uint32_t *>(base.data);
        const uint32_t *afterBits = reinterpret_cast<const uint32_t *>(after.data);
        for (size_t r = 0; r + 1 < ranges.size(); r += 2)
        {
            const size_t start = static_cast<size_t>(ranges[r]) * HISTORY_CHANNELS;
            const size_t count = static_cast<size_t>(ranges[r + 1]) * HISTORY_CHANNELS;
            for (size_t i = 0; i < count; ++i)
            {
                if (baseBits[start + i] != afterBits[start + i])
                {
                    changed = true;
                    return;
                }
            }
        }
    }

    void OnOK() override
    {
        Napi::HandleScope scope(Env());
        deferred.Resolve(Napi::Boolean::New(Env(), changed));
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }
    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    HistoryBufferRef base, after;
    std::vector<uint32_t> ranges;
    bool changed = false;
};

// Builds a stroke's on-disk delta. Layout:
//   [u32 numRanges][u32 ranges...][plane-ordered u32 differences]
//
// Each footprint value is stored as the integer difference of its bit pattern
// from the base's, which reconstruction adds back. Integer arithmetic on the bit
// patterns is exactly invertible — unlike a float subtraction it cannot round —
// so repeated undo/redo never drifts. Storing the difference rather than the
// value leaves untouched pixels as runs of zeros and barely-touched ones as
// small integers, which halves the compressed size of a stroke.
class HistoryEncodeDeltaWorker : public Napi::AsyncWorker
{
public:
    HistoryEncodeDeltaWorker(Napi::Env env, const Napi::Value &baseJs, const Napi::Value &afterJs,
                             const Napi::Uint32Array &rangesJs)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env))
    {
        base.hold(baseJs);
        after.hold(afterJs);
        ranges.assign(rangesJs.Data(), rangesJs.Data() + rangesJs.ElementLength());
    }

    void Execute() override
    {
        size_t total = 0;
        for (size_t r = 1; r < ranges.size(); r += 2)
            total += static_cast<size_t>(ranges[r]) * HISTORY_CHANNELS;

        const size_t valueCount = base.byteLength / HISTORY_VALUE_BYTES;
        if (after.byteLength != base.byteLength)
        {
            SetError("history delta: the painted state is a different size to the base");
            return;
        }
        for (size_t r = 0; r + 1 < ranges.size(); r += 2)
        {
            const size_t end = (static_cast<size_t>(ranges[r]) + ranges[r + 1]) * HISTORY_CHANNELS;
            if (end > valueCount)
            {
                SetError("history delta: footprint range runs past the end of the state");
                return;
            }
        }

        const uint32_t *baseBits = reinterpret_cast<const uint32_t *>(base.data);
        const uint32_t *afterBits = reinterpret_cast<const uint32_t *>(after.data);

        std::vector<uint32_t> diff(total);
        size_t p = 0;
        for (size_t r = 0; r + 1 < ranges.size(); r += 2)
        {
            const size_t start = static_cast<size_t>(ranges[r]) * HISTORY_CHANNELS;
            const size_t count = static_cast<size_t>(ranges[r + 1]) * HISTORY_CHANNELS;
            for (size_t i = 0; i < count; ++i)
                diff[p + i] = afterBits[start + i] - baseBits[start + i];
            p += count;
        }

        const size_t headerBytes = 4 + ranges.size() * sizeof(uint32_t);
        out.resize(headerBytes + total * sizeof(uint32_t));
        const uint32_t numRanges = static_cast<uint32_t>(ranges.size() / 2);
        memcpy(out.data(), &numRanges, 4);
        if (!ranges.empty())
            memcpy(out.data() + 4, ranges.data(), ranges.size() * sizeof(uint32_t));
        if (total > 0)
            historyEncodePlanes(reinterpret_cast<const uint8_t *>(diff.data()), total, out.data() + headerBytes);
    }

    void OnOK() override
    {
        Napi::HandleScope scope(Env());
        deferred.Resolve(Napi::Buffer<uint8_t>::Copy(Env(), out.data(), out.size()));
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }
    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    HistoryBufferRef base, after;
    std::vector<uint32_t> ranges;
    std::vector<uint8_t> out;
};

// Reconstructs the state a delta describes: a copy of the base with the stored
// bit-pattern differences added back over the footprint ranges.
class HistoryApplyDeltaWorker : public Napi::AsyncWorker
{
public:
    HistoryApplyDeltaWorker(Napi::Env env, const Napi::Value &baseJs, const Napi::Value &deltaJs)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env))
    {
        base.hold(baseJs);
        delta.hold(deltaJs);
    }

    void Execute() override
    {
        if (delta.byteLength < 4)
        {
            SetError("history delta is truncated");
            return;
        }
        uint32_t numRanges = 0;
        memcpy(&numRanges, delta.data, 4);
        const size_t rangeValues = static_cast<size_t>(numRanges) * 2;
        const size_t headerBytes = 4 + rangeValues * sizeof(uint32_t);
        if (delta.byteLength < headerBytes)
        {
            SetError("history delta header is truncated");
            return;
        }
        std::vector<uint32_t> ranges(rangeValues);
        if (rangeValues > 0)
            memcpy(ranges.data(), delta.data + 4, rangeValues * sizeof(uint32_t));

        const size_t diffBytes = delta.byteLength - headerBytes;
        std::vector<uint32_t> diff(diffBytes / sizeof(uint32_t));
        if (!diff.empty())
            historyDecodePlanes(delta.data + headerBytes, diff.size(), reinterpret_cast<uint8_t *>(diff.data()));

        out.assign(base.data, base.data + base.byteLength);
        uint32_t *outBits = reinterpret_cast<uint32_t *>(out.data());
        const uint32_t *baseBits = reinterpret_cast<const uint32_t *>(base.data);
        const size_t valueCount = base.byteLength / HISTORY_VALUE_BYTES;

        size_t p = 0;
        for (size_t r = 0; r + 1 < ranges.size(); r += 2)
        {
            const size_t start = static_cast<size_t>(ranges[r]) * HISTORY_CHANNELS;
            const size_t count = static_cast<size_t>(ranges[r + 1]) * HISTORY_CHANNELS;
            if (start + count > valueCount || p + count > diff.size())
            {
                SetError("history delta range is out of bounds");
                return;
            }
            for (size_t i = 0; i < count; ++i)
                outBits[start + i] = baseBits[start + i] + diff[p + i];
            p += count;
        }
    }

    void OnOK() override
    {
        Napi::HandleScope scope(Env());
        Napi::Float32Array result = Napi::Float32Array::New(Env(), out.size() / HISTORY_VALUE_BYTES);
        memcpy(result.Data(), out.data(), out.size());
        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }
    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    HistoryBufferRef base, delta;
    std::vector<uint8_t> out;
};

// Rebuilds the inverse map (each packed pixel's time offset and band index) from
// a band layout. The analysis writes the same values every time, so the history
// derives it on load rather than storing a copy beside every full snapshot.
class HistoryInverseMapWorker : public Napi::AsyncWorker
{
public:
    HistoryInverseMapWorker(Napi::Env env, const Napi::Uint32Array &offsetsJs, const Napi::Uint32Array &lengthsJs,
                            const Napi::Int32Array &stepLog2sJs, size_t pixelCount)
        : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), pixelCount(pixelCount)
    {
        bandOffsets.assign(offsetsJs.Data(), offsetsJs.Data() + offsetsJs.ElementLength());
        bandLengths.assign(lengthsJs.Data(), lengthsJs.Data() + lengthsJs.ElementLength());
        bandStepLog2s.assign(stepLog2sJs.Data(), stepLog2sJs.Data() + stepLog2sJs.ElementLength());
    }

    void Execute() override
    {
        out.assign(pixelCount * 2, 0.0f);
        const size_t numBands = bandOffsets.size();
        for (size_t band = 0; band < numBands; ++band)
        {
            const uint64_t timeStep = 1ULL << bandStepLog2s[band];
            const size_t offset = bandOffsets[band];
            for (uint32_t i = 0; i < bandLengths[band]; ++i)
            {
                const size_t pixel = offset + i;
                if (pixel >= pixelCount)
                    break;
                out[pixel * 2 + 0] = static_cast<float>(i * timeStep);
                out[pixel * 2 + 1] = static_cast<float>(band);
            }
        }
    }

    void OnOK() override
    {
        Napi::HandleScope scope(Env());
        Napi::Float32Array result = Napi::Float32Array::New(Env(), out.size());
        memcpy(result.Data(), out.data(), out.size() * sizeof(float));
        deferred.Resolve(result);
    }

    void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }
    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    size_t pixelCount;
    std::vector<uint32_t> bandOffsets, bandLengths;
    std::vector<int32_t> bandStepLog2s;
    std::vector<float> out;
};

Napi::Value HistoryEncodePlanesAsync(const Napi::CallbackInfo &info)
{
    auto *worker = new HistoryEncodePlanesWorker(info.Env(), info[0]);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value HistoryDecodePlanesAsync(const Napi::CallbackInfo &info)
{
    auto *worker = new HistoryDecodePlanesWorker(info.Env(), info[0]);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value HistoryFootprintChangedAsync(const Napi::CallbackInfo &info)
{
    auto *worker = new HistoryFootprintChangedWorker(info.Env(), info[0], info[1], info[2].As<Napi::Uint32Array>());
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value HistoryEncodeDeltaAsync(const Napi::CallbackInfo &info)
{
    auto *worker = new HistoryEncodeDeltaWorker(info.Env(), info[0], info[1], info[2].As<Napi::Uint32Array>());
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value HistoryApplyDeltaAsync(const Napi::CallbackInfo &info)
{
    auto *worker = new HistoryApplyDeltaWorker(info.Env(), info[0], info[1]);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value HistoryInverseMapAsync(const Napi::CallbackInfo &info)
{
    auto *worker = new HistoryInverseMapWorker(info.Env(), info[0].As<Napi::Uint32Array>(),
                                               info[1].As<Napi::Uint32Array>(), info[2].As<Napi::Int32Array>(),
                                               info[3].As<Napi::Number>().Int64Value());
    worker->Queue();
    return worker->GetPromise();
}

/**
 * Reports the GPU memory available to textures, in bytes. On Windows this
 * queries DXGI across all adapters; integrated GPUs report almost no dedicated
 * memory but render from the shared system pool, so the larger of dedicated
 * and half the shared pool is used. Returns 0 where no query exists (macOS
 * has unified memory, so the caller uses total system RAM instead).
 */
Napi::Value GetGpuMemoryBytes(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
#ifdef _WIN32
    IDXGIFactory *factory = nullptr;
    if (SUCCEEDED(CreateDXGIFactory(__uuidof(IDXGIFactory), (void **)&factory)))
    {
        SIZE_T best = 0;
        IDXGIAdapter *adapter = nullptr;
        for (UINT i = 0; factory->EnumAdapters(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i)
        {
            DXGI_ADAPTER_DESC desc;
            if (SUCCEEDED(adapter->GetDesc(&desc)))
            {
                SIZE_T usable = std::max(desc.DedicatedVideoMemory, desc.SharedSystemMemory / 2);
                best = std::max(best, usable);
            }
            adapter->Release();
        }
        factory->Release();
        if (best > 0)
            return Napi::Number::New(env, (double)best);
    }
#endif
    return Napi::Number::New(env, 0.0);
}

Napi::Object init(Napi::Env env, Napi::Object exports)
{
    exports.Set("historyEncodePlanes", Napi::Function::New(env, HistoryEncodePlanesAsync));
    exports.Set("historyDecodePlanes", Napi::Function::New(env, HistoryDecodePlanesAsync));
    exports.Set("historyFootprintChanged", Napi::Function::New(env, HistoryFootprintChangedAsync));
    exports.Set("historyEncodeDelta", Napi::Function::New(env, HistoryEncodeDeltaAsync));
    exports.Set("historyApplyDelta", Napi::Function::New(env, HistoryApplyDeltaAsync));
    exports.Set("historyInverseMap", Napi::Function::New(env, HistoryInverseMapAsync));
    exports.Set("analyze", Napi::Function::New(env, AnalyzeAsync));
    exports.Set("getGpuMemoryBytes", Napi::Function::New(env, GetGpuMemoryBytes));
    exports.Set("synthesize", Napi::Function::New(env, SynthesizeAsync));
    exports.Set("commitStroke", Napi::Function::New(env, CommitStrokeAsync));
    exports.Set("detectOnsets", Napi::Function::New(env, DetectOnsetsAsync));
    exports.Set("applyLimiter", Napi::Function::New(env, ApplyLimiterTest));
    exports.Set("hpss", Napi::Function::New(env, HpssAsync));
    exports.Set("nmf", Napi::Function::New(env, NmfAsync));
    exports.Set("mergeSpectrograms", Napi::Function::New(env, MergeSpectrogramsAsync));
#ifdef GABORATOR_ONNX_ENABLED
    exports.Set("aiSeparate", Napi::Function::New(env, AiSeparateAsync));
#endif
    return exports;
}

NODE_API_MODULE(gaborator_addon, init);