#include "effect-common.glsl"
#include "edge-mode.glsl"

uniform Parameter cloneSpaceX;
uniform Parameter cloneSpaceY;
uniform int cloneCount;
uniform Parameter cloneDecay;
uniform vec2 cloneDirection; // (1,0) for time pass, (0,1) for pitch pass
uniform int cloneDirectionMode; // 0=forward/up, 1=middle, 2=backward/down
uniform int cloneEdgeMode;

void main() {
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
    vec2 spaceX = applyModulation(cloneSpaceX.value, cloneSpaceX.minValue, cloneSpaceX.maxValue, cloneSpaceX.modulationAmounts, cloneSpaceX.contextualModAmounts, cloneSpaceX.macroAmounts, coords.dest, 0, audioLevelDb);
    vec2 spaceY = applyModulation(cloneSpaceY.value, cloneSpaceY.minValue, cloneSpaceY.maxValue, cloneSpaceY.modulationAmounts, cloneSpaceY.contextualModAmounts, cloneSpaceY.macroAmounts, coords.dest, 0, audioLevelDb);
    vec2 space = isXPass ? spaceX : spaceY;

    int count = clamp(cloneCount, 1, 32);

    vec2 decayFactor = clamp(
        applyModulation(cloneDecay.value, cloneDecay.minValue, cloneDecay.maxValue, cloneDecay.modulationAmounts, cloneDecay.contextualModAmounts, cloneDecay.macroAmounts, coords.dest, 0, audioLevelDb),
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

    vec2 sumL = vec2(0.0);
    vec2 sumR = vec2(0.0);
    float totalWeightL = 0.0;
    float totalWeightR = 0.0;

    for (int s = 0; s < 32; s++) {
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

        // Sample opposite to the echo direction: content at S appears as copies
        // at S + k*space (Forward = +space, Backward = -space).
        vec2 offsetL = -cloneDirection * offsetIdx * space.x;
        vec2 sampleUvL = coords.sourceL + offsetL;
        bool inL = cloneEdgeMode != 0 || isInsideSourceBrush(sampleUvL);

        if (sameTaps) {
            if (!inL) continue;
            float w = pow(max(1.0 - decayFactor.x, 1e-6), normDist);
            vec2 totalShift = vec2(sourceOffsetX, sourceOffsetY) + offsetL;
            vec4 sampleTexel = sampleWithEdgeMode(sampleUvL, coords.dest, totalShift.x, totalShift.y, cloneEdgeMode);
            sumL += toComplex(sampleTexel.rg) * w;
            sumR += toComplex(sampleTexel.ba) * w;
            totalWeightL += w;
            totalWeightR += w;
        } else {
            vec2 offsetR = -cloneDirection * offsetIdx * space.y;
            vec2 sampleUvR = coords.sourceR + offsetR;
            bool inR = cloneEdgeMode != 0 || isInsideSourceBrush(sampleUvR);
            if (inL) {
                float wL = pow(max(1.0 - decayFactor.x, 1e-6), normDist);
                vec2 totalShiftL = vec2(sourceOffsetX, sourceOffsetY) + offsetL;
                vec4 sampleTexelL = sampleWithEdgeMode(sampleUvL, coords.dest, totalShiftL.x, totalShiftL.y, cloneEdgeMode);
                sumL += toComplex(sampleTexelL.rg) * wL;
                totalWeightL += wL;
            }
            if (inR) {
                float wR = pow(max(1.0 - decayFactor.y, 1e-6), normDist);
                vec2 totalShiftR = vec2(sourceOffsetX, sourceOffsetY) + offsetR;
                vec4 sampleTexelR = sampleWithEdgeMode(sampleUvR, coords.dest, totalShiftR.x, totalShiftR.y, cloneEdgeMode);
                sumR += toComplex(sampleTexelR.ba) * wR;
                totalWeightR += wR;
            }
        }
    }

    vec4 resultTexel;
    if (totalWeightL > 0.0 || totalWeightR > 0.0) {
        vec2 polL = totalWeightL > 0.0 ? polarFromComplex(sumL) : originalTexel.rg;
        vec2 polR = totalWeightR > 0.0 ? polarFromComplex(sumR) : originalTexel.ba;
        resultTexel = vec4(polL, polR);
    } else {
        resultTexel = originalTexel;
    }

    outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
