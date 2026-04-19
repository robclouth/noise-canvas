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
    float weight = getBrushWeight(coords.dest, audioLevelDb);
    if (weight <= 0.0) {
        outColor = originalTexel;
        return;
    }

    bool isXPass = cloneDirection.x > 0.5;

    float spaceX = applyModulation(cloneSpaceX.value, cloneSpaceX.minValue, cloneSpaceX.maxValue, cloneSpaceX.modulationAmounts, cloneSpaceX.contextualModAmounts, cloneSpaceX.macroAmounts, coords.dest, 0, audioLevelDb);
    float spaceY = applyModulation(cloneSpaceY.value, cloneSpaceY.minValue, cloneSpaceY.maxValue, cloneSpaceY.modulationAmounts, cloneSpaceY.contextualModAmounts, cloneSpaceY.macroAmounts, coords.dest, 0, audioLevelDb);
    float space = isXPass ? spaceX : spaceY;

    int count = clamp(cloneCount, 1, 32);

    float decayFactor = clamp(
        applyModulation(cloneDecay.value, cloneDecay.minValue, cloneDecay.maxValue, cloneDecay.modulationAmounts, cloneDecay.contextualModAmounts, cloneDecay.macroAmounts, coords.dest, 0, audioLevelDb),
        0.0, 1.0
    );

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
    float totalWeight = 0.0;

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

        vec2 offset = cloneDirection * offsetIdx * space;
        vec2 sampleUv = coords.source + offset;

        if (cloneEdgeMode == 0 && !isInsideBrush(sampleUv)) continue;

        float normDist = abs(offsetIdx) / maxAbsOffset;
        float w = pow(max(1.0 - decayFactor, 1e-6), normDist);

        vec2 totalShift = vec2(sourceOffsetX, sourceOffsetY) + offset;
        vec4 sampleTexel = sampleWithEdgeMode(sampleUv, coords.dest, totalShift.x, totalShift.y, cloneEdgeMode);

        sumL += toComplex(sampleTexel.rg) * w;
        sumR += toComplex(sampleTexel.ba) * w;
        totalWeight += w;
    }

    vec4 resultTexel;
    if (totalWeight > 0.0) {
        resultTexel = vec4(polarFromComplex(sumL), polarFromComplex(sumR));
    } else {
        resultTexel = originalTexel;
    }

    outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
