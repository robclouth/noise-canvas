#include "effect-common.glsl"

// A neural cellular automaton over the spectrogram. Every band reads its 3×3
// neighbourhood of levels, a small seeded network turns what it sees into a
// change of level and phase, and each pass is one generation: the next pass
// reads this one's output, so the network keeps rewriting its own result.

#define NEURAL_INPUTS 8
#define NEURAL_HIDDEN 8

uniform float neuralW1[NEURAL_HIDDEN * NEURAL_INPUTS];
uniform float neuralB1[NEURAL_HIDDEN];
uniform float neuralW2[2 * NEURAL_HIDDEN];

uniform Parameter neuralRate;
uniform Parameter neuralChaos;
uniform Parameter neuralTwist;
uniform Parameter neuralReachX; // beats, converted via neuralUvPerBeat
uniform Parameter neuralReachY; // semitones
uniform float neuralUvPerBeat;
uniform float neuralGeneration; // 0 on the first generation, 1 on the last
uniform int neuralEdgeMode;

#include "edge-mode.glsl"

// Levels are read on a 90 dB log scale: 0 is silence, 1 is full scale.
const float NEURAL_DB_RANGE = 90.0;
// How far one generation can move a level at full Rate, on that scale.
const float NEURAL_MAX_STEP = 0.25;
// Perception features other than the centre level are small differences;
// this brings them up to the centre's range before they reach the network.
const float NEURAL_FEATURE_GAIN = 4.0;

float levelOf(float mag) {
    float db = 20.0 * log(max(mag, 1e-12)) / log(10.0);
    return max(1.0 + db / NEURAL_DB_RANGE, 0.0);
}

float magOf(float level) {
    if (level <= 0.0) return 0.0;
    return pow(10.0, (level - 1.0) * NEURAL_DB_RANGE / 20.0);
}

// Both channels' levels at one tap, after the edge mode has had its say.
vec2 tapLevels(vec2 sourceUv) {
    bool useZero, invertSample;
    vec2 edgeUv = applyEdgeMode(sourceUv, neuralEdgeMode, useZero, invertSample);
    if (useZero) return vec2(0.0);
    vec4 texel = sampleSourceInterp(edgeUv);
    vec2 levels = vec2(levelOf(getMag(texel.rg)), levelOf(getMag(texel.ba)));
    // Invert flips the sample; on a level scale that is a mirror about half.
    return invertSample ? 1.0 - levels : levels;
}

// The 3×3 neighbourhood around `centre`, indexed (pitch + 1) * 3 + (time + 1).
void readNeighbourhood(vec2 centre, vec2 step, out vec2 taps[9]) {
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            taps[(dy + 1) * 3 + (dx + 1)] = tapLevels(centre + vec2(float(dx), float(dy)) * step);
        }
    }
}

void perceive(float n[9], float otherCentre, out float f[NEURAL_INPUTS]) {
    float c = n[4];
    float sobelX = ((n[2] + 2.0 * n[5] + n[8]) - (n[0] + 2.0 * n[3] + n[6])) / 8.0;
    float sobelY = ((n[6] + 2.0 * n[7] + n[8]) - (n[0] + 2.0 * n[1] + n[2])) / 8.0;
    float sum = 0.0;
    float peak = 0.0;
    for (int i = 0; i < 9; i++) {
        if (i == 4) continue;
        sum += n[i];
        peak = max(peak, n[i]);
    }
    f[0] = c * 2.0 - 1.0;
    f[1] = sobelX * NEURAL_FEATURE_GAIN;
    f[2] = sobelY * NEURAL_FEATURE_GAIN;
    f[3] = (sum / 8.0 - c) * NEURAL_FEATURE_GAIN;
    f[4] = (peak - c) * NEURAL_FEATURE_GAIN;
    f[5] = ((n[2] + n[6]) - (n[0] + n[8])) * 0.5 * NEURAL_FEATURE_GAIN;
    f[6] = (c - otherCentre) * NEURAL_FEATURE_GAIN;
    f[7] = neuralGeneration * 2.0 - 1.0;
}

vec2 forward(float f[NEURAL_INPUTS], float gain) {
    vec2 out2 = vec2(0.0);
    for (int j = 0; j < NEURAL_HIDDEN; j++) {
        float pre = neuralB1[j];
        for (int i = 0; i < NEURAL_INPUTS; i++) {
            pre += neuralW1[j * NEURAL_INPUTS + i] * f[i];
        }
        float h = tanh(gain * pre);
        out2 += vec2(neuralW2[j], neuralW2[NEURAL_HIDDEN + j]) * h;
    }
    return out2;
}

// The network's change of level and phase for one channel. What it would do
// to a featureless neighbourhood at the same level is taken away, so flat,
// even regions hold still and only the structure in the sound drives growth.
vec2 network(float n[9], float otherCentre, float gain) {
    float f[NEURAL_INPUTS];
    perceive(n, otherCentre, f);
    float featureless[NEURAL_INPUTS];
    for (int i = 0; i < NEURAL_INPUTS; i++) featureless[i] = 0.0;
    featureless[0] = f[0];
    featureless[7] = f[7];
    return tanh(2.0 * (forward(f, gain) - forward(featureless, gain)));
}

// Growth stops at the loudest level in the neighbourhood, so energy can
// spread and move but never climbs past what is already around it.
float neighbourhoodPeak(float n[9]) {
    float peak = 0.0;
    for (int i = 0; i < 9; i++) peak = max(peak, n[i]);
    return peak;
}

vec2 evolveChannel(vec2 magPhase, float n[9], float otherCentre, float rate, float chaos, float twist) {
    float gain = 0.5 + 3.5 * chaos;
    vec2 delta = network(n, otherCentre, gain);
    float current = levelOf(getMag(magPhase));
    float ceiling = max(neighbourhoodPeak(n), current);
    float level = min(current + delta.x * rate * NEURAL_MAX_STEP, ceiling);
    float phase = getPhase(magPhase) + delta.y * twist * PI;
    return fromPolar(magOf(level), phase);
}

void main() {
    vec2 destUv = packedToUnpackedUv(destInverseMapTex, vUv, destFrameCount, destBandCount);
    if (brushWeightIsZero(destUv)) {
        outColor = texture(destSpectrogramTex, vUv);
        return;
    }
    ProcessingUvs coords = getProcessingUvs(vUv);
    vec4 originalTexel = texture(destSpectrogramTex, vUv);
    float audioLevelDb = getAudioLevelDb(coords.dest);
    vec2 weight = getBrushWeight(coords.dest, audioLevelDb);
    if (weight.x <= 0.0 && weight.y <= 0.0) {
        outColor = originalTexel;
        return;
    }

    vec2 mods[NUM_MODULATORS];
    sampleModulators(mods);
    vec2 rate = resolveParameter(neuralRate, mods) / 100.0;
    vec2 chaos = resolveParameter(neuralChaos, mods) / 100.0;
    vec2 twist = resolveParameter(neuralTwist, mods) / 100.0;
    float reachBeats = resolveParameterMono(neuralReachX, mods);
    float reachSemis = resolveParameterMono(neuralReachY, mods);

    // One tap step in source UV: beats through the source's time scale, and
    // semitones through the source's own band layout.
    vec2 step = vec2(
        reachBeats * neuralUvPerBeat * sourceTimeScale,
        reachSemis * (sourceBandsPerOctave / 12.0) / max(sourceBandCount, 1.0)
    );

    vec4 centreL = sampleWithEdgeMode(coords.sourceL, coords.dest, sourceOffsetX, sourceOffsetY, neuralEdgeMode);
    vec4 centreR = coords.sameSourceUv
        ? centreL
        : sampleWithEdgeMode(coords.sourceR, coords.dest, sourceOffsetX, sourceOffsetY, neuralEdgeMode);

    vec2 tapsL[9];
    readNeighbourhood(coords.sourceL, step, tapsL);
    vec2 tapsR[9];
    if (coords.sameSourceUv) {
        tapsR = tapsL;
    } else {
        readNeighbourhood(coords.sourceR, step, tapsR);
    }

    float nL[9];
    float nR[9];
    for (int i = 0; i < 9; i++) {
        nL[i] = tapsL[i].x;
        nR[i] = tapsR[i].y;
    }

    vec4 resultTexel = vec4(
        evolveChannel(centreL.rg, nL, nR[4], rate.x, chaos.x, twist.x),
        evolveChannel(centreR.ba, nR, nL[4], rate.y, chaos.y, twist.y)
    );

    outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
