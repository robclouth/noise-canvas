#include "effect-common.glsl"
#include "edge-mode.glsl"
#include "scale-snap.glsl"

// Gap values arrive in knob units — the log-bipolar beat scale on X, semitones
// on Y — so modulation sweeps the knob's own arc. They convert to UV here.
uniform Parameter cloneSpaceX;
uniform Parameter cloneSpaceY;
uniform float cloneBeatsLog; // log1p of the beats range, the log-bipolar curve constant
uniform float cloneBeatsToUv; // file UV per beat
uniform int cloneCount;
uniform Parameter cloneDecay;
uniform vec2 cloneDirection; // (1,0) for time pass, (0,1) for pitch pass
uniform int cloneDirectionMode; // 0=forward/up, 1=middle, 2=backward/down
uniform int cloneEdgeMode;
uniform bool cloneScaleSnap; // pitch pass with the Scale shape: land every tap on an in-scale note
uniform sampler2D cloneShapeTex;

// Tap position in Gap units. The table holds one entry per copy; Middle mode
// asks for half indices, so entries are interpolated and mirrored about zero.
float shapeStep(float offsetIdx, int tableSize) {
    float a = abs(offsetIdx);
    float last = float(max(tableSize - 1, 0));
    float i0 = clamp(floor(a), 0.0, last);
    float i1 = min(i0 + 1.0, last);
    float frac = clamp(a - i0, 0.0, 1.0);
    float v0 = texelFetch(cloneShapeTex, ivec2(int(i0), 0), 0).r;
    float v1 = texelFetch(cloneShapeTex, ivec2(int(i1), 0), 0).r;
    return mix(v0, v1, frac) * sign(offsetIdx);
}

// Per-tap gain: Decay maps linearly to dB of attenuation, reaching -60 dB at
// the outermost copy at 100%, where every copy past the first mutes outright.
float tapWeight(float decay, float normDist) {
    if (decay >= 1.0) return normDist > 0.0 ? 0.0 : 1.0;
    return pow(10.0, -3.0 * decay * normDist);
}

float semisToUv(float semis) {
    return semis * (destBandsPerOctave / 12.0) / destBandCount;
}

// Pitch offset of one tap in UV, moved so the copy lands on an in-scale note.
// Anchored to the brush base pitch, so content painted on a scale note stays
// on scale notes.
float snappedPitchStepUv(float rawSemis) {
    float target = brushBasePitchAbsSemis + rawSemis;
    return semisToUv(snapToScale(target) - brushBasePitchAbsSemis);
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

    bool isXPass = cloneDirection.x > 0.5;

    // Stereo-aware tap geometry + per-tap decay. When all are equal across
    // channels and source UVs match, the sample-once fast path triggers per tap.
    vec2 mods[NUM_MODULATORS];
    sampleModulators(mods);

    vec2 space;
    vec2 spaceSemis = vec2(0.0);
    if (isXPass) {
        vec2 pos = clamp(applyModulationCached(cloneSpaceX.value, cloneSpaceX.minValue, cloneSpaceX.maxValue, cloneSpaceX.modulationAmounts, cloneSpaceX.contextualModAmounts, cloneSpaceX.macroAmounts, mods), 0.0, 1.0);
        vec2 arc = pos * 2.0 - 1.0;
        vec2 beats = sign(arc) * (exp(abs(arc) * cloneBeatsLog) - 1.0);
        space = beats * cloneBeatsToUv;
    } else {
        spaceSemis = applyModulationCached(cloneSpaceY.value, cloneSpaceY.minValue, cloneSpaceY.maxValue, cloneSpaceY.modulationAmounts, cloneSpaceY.contextualModAmounts, cloneSpaceY.macroAmounts, mods);
        space = vec2(semisToUv(spaceSemis.x), semisToUv(spaceSemis.y));
    }

    int count = clamp(cloneCount, 1, 64);
    int tableSize = textureSize(cloneShapeTex, 0).x;

    vec2 decayFactor = clamp(
        applyModulationCached(cloneDecay.value, cloneDecay.minValue, cloneDecay.maxValue, cloneDecay.modulationAmounts, cloneDecay.contextualModAmounts, cloneDecay.macroAmounts, mods),
        0.0, 1.0
    );

    bool sameTaps = (space.x == space.y) && (decayFactor.x == decayFactor.y) && coords.sameSourceUv;

    // maxAbsOffset determines how quickly weight falls off toward the outermost copies.
    // Middle mode spreads ± so farthest tap is (count-1)/2 hops from center.
    float maxAbsOffset;
    if (cloneDirectionMode == 1) {
        maxAbsOffset = float(count - 1) * 0.5;
    } else {
        maxAbsOffset = float(count - 1);
    }
    maxAbsOffset = max(maxAbsOffset, 1.0);

    // Seconds a copy is displaced by, for the carrier correction that keeps a
    // cloned attack coherent at the time it lands on.
    float destFreqHz = getDestMetadata(coords.dest).a;
    float uvToSec = destFrameCount / max(destSampleRate, 1e-6);

    vec2 sumL = vec2(0.0);
    vec2 sumR = vec2(0.0);
    float totalWeightL = 0.0;
    float totalWeightR = 0.0;

    // The bound must stay uniform-derived. A literal bound gives the loop a
    // constant trip count, which ANGLE's D3D backend fully unrolls, multiplying
    // this program's link time several times over.
    for (int s = 0; s < count; s++) {
        float offsetIdx;
        if (cloneDirectionMode == 0) {
            offsetIdx = float(s);
        } else if (cloneDirectionMode == 2) {
            offsetIdx = -float(s);
        } else {
            offsetIdx = float(s) - float(count - 1) * 0.5;
        }

        float normDist = abs(offsetIdx) / maxAbsOffset;
        float tapStep = shapeStep(offsetIdx, tableSize);

        // Sample opposite to the echo direction: content at S appears as copies
        // at S + k*space (Forward = +space, Backward = -space).
        float stepUvL = cloneScaleSnap ? snappedPitchStepUv(tapStep * spaceSemis.x) : tapStep * space.x;
        vec2 offsetL = -cloneDirection * stepUvL;
        vec2 sampleUvL = coords.sourceL + offsetL;
        // A pitch copy past the top or bottom band is dropped, unless the pitch
        // axis wraps — then it comes back in from the other end.
        bool withinPitchL = isXPass || wrapsPitchAxis() || (sampleUvL.y >= 0.0 && sampleUvL.y <= 1.0);
        bool inL = withinPitchL && (cloneEdgeMode != 0 || isInsideSourceBrush(sampleUvL));

        if (sameTaps) {
            if (!inL) continue;
            float w = tapWeight(decayFactor.x, normDist);
            vec2 totalShift = vec2(sourceOffsetX, sourceOffsetY) + offsetL;
            vec4 sampleTexel = sampleWithEdgeMode(sampleUvL, coords.dest, totalShift.x, totalShift.y, cloneEdgeMode);
            float dtSec = (coords.dest.x - sampleUvL.x) * uvToSec;
            sampleTexel.g = reanchorTimeShift(sampleUvL, sampleTexel.g, destFreqHz, dtSec);
            sampleTexel.a = reanchorTimeShift(sampleUvL, sampleTexel.a, destFreqHz, dtSec);
            sumL += toComplex(sampleTexel.rg) * w;
            sumR += toComplex(sampleTexel.ba) * w;
            totalWeightL += w;
            totalWeightR += w;
        } else {
            float stepUvR = cloneScaleSnap ? snappedPitchStepUv(tapStep * spaceSemis.y) : tapStep * space.y;
            vec2 offsetR = -cloneDirection * stepUvR;
            vec2 sampleUvR = coords.sourceR + offsetR;
            bool withinPitchR = isXPass || wrapsPitchAxis() || (sampleUvR.y >= 0.0 && sampleUvR.y <= 1.0);
            bool inR = withinPitchR && (cloneEdgeMode != 0 || isInsideSourceBrush(sampleUvR));
            if (inL) {
                float wL = tapWeight(decayFactor.x, normDist);
                vec2 totalShiftL = vec2(sourceOffsetX, sourceOffsetY) + offsetL;
                vec4 sampleTexelL = sampleWithEdgeMode(sampleUvL, coords.dest, totalShiftL.x, totalShiftL.y, cloneEdgeMode);
                float dtSecL = (coords.dest.x - sampleUvL.x) * uvToSec;
                sampleTexelL.g = reanchorTimeShift(sampleUvL, sampleTexelL.g, destFreqHz, dtSecL);
                sumL += toComplex(sampleTexelL.rg) * wL;
                totalWeightL += wL;
            }
            if (inR) {
                float wR = tapWeight(decayFactor.y, normDist);
                vec2 totalShiftR = vec2(sourceOffsetX, sourceOffsetY) + offsetR;
                vec4 sampleTexelR = sampleWithEdgeMode(sampleUvR, coords.dest, totalShiftR.x, totalShiftR.y, cloneEdgeMode);
                float dtSecR = (coords.dest.x - sampleUvR.x) * uvToSec;
                sampleTexelR.a = reanchorTimeShift(sampleUvR, sampleTexelR.a, destFreqHz, dtSecR);
                sumR += toComplex(sampleTexelR.ba) * wR;
                totalWeightR += wR;
            }
        }
    }

    vec4 resultTexel;
    if (totalWeightL > 0.0 || totalWeightR > 0.0) {
        resultTexel = vec4(
            totalWeightL > 0.0 ? polarFromComplex(sumL) : originalTexel.rg,
            totalWeightR > 0.0 ? polarFromComplex(sumR) : originalTexel.ba
        );
    } else {
        resultTexel = originalTexel;
    }

    outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
