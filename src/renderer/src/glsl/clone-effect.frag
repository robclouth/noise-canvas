#include "effect-common.glsl"
#include "edge-mode.glsl"

uniform Parameter cloneSpaceX;
uniform Parameter cloneSpaceY;
uniform int cloneCount;
uniform Parameter cloneDecay;
uniform vec2 cloneDirection; // (1,0) for time pass, (0,1) for pitch pass
uniform int cloneDirectionMode; // 0=forward/up, 1=middle, 2=backward/down
uniform int cloneEdgeMode;
uniform int cloneSumMode; // 0=coherent complex sum, 1=constructive magnitude sum
uniform sampler2D cloneShapeTex;

// Tap position in Space units. The table holds one entry per copy; Middle mode
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

void accumulateTap(vec2 magPhase, float w, bool constructive,
                   inout vec2 sumZ, inout float sumMag, inout float sumPhase,
                   inout float refPhase, inout bool haveRef, inout float totalWeight) {
    if (constructive) {
        float phase = getPhase(magPhase);
        if (!haveRef) {
            refPhase = phase;
            haveRef = true;
        }
        sumMag += getMag(magPhase) * w;
        sumPhase += (refPhase + unwrapPhase(phase - refPhase)) * w;
    } else {
        sumZ += toComplex(magPhase) * w;
    }
    totalWeight += w;
}

vec2 resolveTaps(bool constructive, vec2 sumZ, float sumMag, float sumPhase, float totalWeight, vec2 fallback) {
    if (totalWeight <= 0.0) return fallback;
    return constructive ? fromPolar(sumMag, sumPhase / totalWeight) : polarFromComplex(sumZ);
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
    vec2 spaceX = applyModulationCached(cloneSpaceX.value, cloneSpaceX.minValue, cloneSpaceX.maxValue, cloneSpaceX.modulationAmounts, cloneSpaceX.contextualModAmounts, cloneSpaceX.macroAmounts, mods);
    vec2 spaceY = applyModulationCached(cloneSpaceY.value, cloneSpaceY.minValue, cloneSpaceY.maxValue, cloneSpaceY.modulationAmounts, cloneSpaceY.contextualModAmounts, cloneSpaceY.macroAmounts, mods);
    vec2 space = isXPass ? spaceX : spaceY;

    int count = clamp(cloneCount, 1, 64);
    int tableSize = textureSize(cloneShapeTex, 0).x;
    bool constructive = cloneSumMode == 1;

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
    float sumMagL = 0.0;
    float sumMagR = 0.0;
    float sumPhaseL = 0.0;
    float sumPhaseR = 0.0;
    float refPhaseL = 0.0;
    float refPhaseR = 0.0;
    bool haveRefL = false;
    bool haveRefR = false;
    float totalWeightL = 0.0;
    float totalWeightR = 0.0;

    for (int s = 0; s < 64; s++) {
        if (s >= count) break;

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
        vec2 offsetL = -cloneDirection * tapStep * space.x;
        vec2 sampleUvL = coords.sourceL + offsetL;
        // A pitch copy past the top or bottom band is dropped, unless the pitch
        // axis wraps — then it comes back in from the other end.
        bool withinPitchL = isXPass || wrapsPitchAxis() || (sampleUvL.y >= 0.0 && sampleUvL.y <= 1.0);
        bool inL = withinPitchL && (cloneEdgeMode != 0 || isInsideSourceBrush(sampleUvL));

        if (sameTaps) {
            if (!inL) continue;
            float w = pow(max(1.0 - decayFactor.x, 1e-6), normDist);
            vec2 totalShift = vec2(sourceOffsetX, sourceOffsetY) + offsetL;
            vec4 sampleTexel = sampleWithEdgeMode(sampleUvL, coords.dest, totalShift.x, totalShift.y, cloneEdgeMode);
            float dtSec = (coords.dest.x - sampleUvL.x) * uvToSec;
            sampleTexel.g = reanchorTimeShift(sampleUvL, sampleTexel.g, destFreqHz, dtSec);
            sampleTexel.a = reanchorTimeShift(sampleUvL, sampleTexel.a, destFreqHz, dtSec);
            accumulateTap(sampleTexel.rg, w, constructive, sumL, sumMagL, sumPhaseL, refPhaseL, haveRefL, totalWeightL);
            accumulateTap(sampleTexel.ba, w, constructive, sumR, sumMagR, sumPhaseR, refPhaseR, haveRefR, totalWeightR);
        } else {
            vec2 offsetR = -cloneDirection * tapStep * space.y;
            vec2 sampleUvR = coords.sourceR + offsetR;
            bool withinPitchR = isXPass || wrapsPitchAxis() || (sampleUvR.y >= 0.0 && sampleUvR.y <= 1.0);
            bool inR = withinPitchR && (cloneEdgeMode != 0 || isInsideSourceBrush(sampleUvR));
            if (inL) {
                float wL = pow(max(1.0 - decayFactor.x, 1e-6), normDist);
                vec2 totalShiftL = vec2(sourceOffsetX, sourceOffsetY) + offsetL;
                vec4 sampleTexelL = sampleWithEdgeMode(sampleUvL, coords.dest, totalShiftL.x, totalShiftL.y, cloneEdgeMode);
                float dtSecL = (coords.dest.x - sampleUvL.x) * uvToSec;
                sampleTexelL.g = reanchorTimeShift(sampleUvL, sampleTexelL.g, destFreqHz, dtSecL);
                accumulateTap(sampleTexelL.rg, wL, constructive, sumL, sumMagL, sumPhaseL, refPhaseL, haveRefL, totalWeightL);
            }
            if (inR) {
                float wR = pow(max(1.0 - decayFactor.y, 1e-6), normDist);
                vec2 totalShiftR = vec2(sourceOffsetX, sourceOffsetY) + offsetR;
                vec4 sampleTexelR = sampleWithEdgeMode(sampleUvR, coords.dest, totalShiftR.x, totalShiftR.y, cloneEdgeMode);
                float dtSecR = (coords.dest.x - sampleUvR.x) * uvToSec;
                sampleTexelR.a = reanchorTimeShift(sampleUvR, sampleTexelR.a, destFreqHz, dtSecR);
                accumulateTap(sampleTexelR.ba, wR, constructive, sumR, sumMagR, sumPhaseR, refPhaseR, haveRefR, totalWeightR);
            }
        }
    }

    vec4 resultTexel;
    if (totalWeightL > 0.0 || totalWeightR > 0.0) {
        resultTexel = vec4(
            resolveTaps(constructive, sumL, sumMagL, sumPhaseL, totalWeightL, originalTexel.rg),
            resolveTaps(constructive, sumR, sumMagR, sumPhaseR, totalWeightR, originalTexel.ba)
        );
    } else {
        resultTexel = originalTexel;
    }

    outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
