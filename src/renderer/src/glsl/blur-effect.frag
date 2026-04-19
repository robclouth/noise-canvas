#include "effect-common.glsl"
#include "edge-mode.glsl"

uniform Parameter blurSizeX;
uniform Parameter blurSizeY;
uniform Parameter blurNoiseX;
uniform Parameter blurNoiseY;
uniform vec2 blurDirection; // (1, 0) for horizontal, (0, 1) for vertical
uniform int blurEdgeMode;
uniform int blurSampleCount;
uniform int blurOrigin; // 0=left, 1=middle, 2=right

void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);
    vec4 originalTexel = texture(destSpectrogramTex, vUv);
    float audioLevelDb = getAudioLevelDb(coords.dest);
    float weight = getBrushWeight(coords.dest, audioLevelDb);
    if( weight <= 0.0 ) {
        outColor = originalTexel;
        return;
    }

    float blurredMagL = 0.0;
    float blurredMagR = 0.0;
    float blurredPhaseL = 0.0;
    float blurredPhaseR = 0.0;
    float totalWeight = 0.0;

    vec4 sourceCenterTexel = getTransformedSample(coords.source, coords.dest, sourceTimeScale, sourceBandScale, sourceOffsetX, sourceOffsetY);
    float referencePhaseL = getPhase(sourceCenterTexel.rg);
    float referencePhaseR = getPhase(sourceCenterTexel.ba);

    float blurSizeXValue = applyModulation(blurSizeX.value, blurSizeX.minValue, blurSizeX.maxValue, blurSizeX.modulationAmounts, blurSizeX.contextualModAmounts, blurSizeX.macroAmounts, coords.dest, 0, audioLevelDb);
    float blurSizeYValue = applyModulation(blurSizeY.value, blurSizeY.minValue, blurSizeY.maxValue, blurSizeY.modulationAmounts, blurSizeY.contextualModAmounts, blurSizeY.macroAmounts, coords.dest, 0, audioLevelDb);
    float blurNoiseXValue = applyModulation(blurNoiseX.value, blurNoiseX.minValue, blurNoiseX.maxValue, blurNoiseX.modulationAmounts, blurNoiseX.contextualModAmounts, blurNoiseX.macroAmounts, coords.dest, 0, audioLevelDb);
    float blurNoiseYValue = applyModulation(blurNoiseY.value, blurNoiseY.minValue, blurNoiseY.maxValue, blurNoiseY.modulationAmounts, blurNoiseY.contextualModAmounts, blurNoiseY.macroAmounts, coords.dest, 0, audioLevelDb);

    vec2 blurSizeUv = vec2(blurSizeXValue, blurSizeYValue);

    // radius = half the sample count; sigma scaled so 3-sigma covers the radius
    int radius = blurSampleCount / 2;
    float sigma = float(max(radius, 1)) / 3.0;

    // Loop up to the max possible sample count (64), breaking early once all samples are processed
    for (int s = 0; s < 64; s++) {
        if (s >= blurSampleCount) break;

        int i = s - radius;

        if (blurOrigin == 0 && i > 0) continue; // Left: causal, no future samples
        if (blurOrigin == 2 && i < 0) continue; // Right: anti-causal, no past samples

        vec2 offset = blurDirection * float(i) * blurSizeUv / float(max(radius, 1));
        
        // Noise offset direction follows origin mode
        float noiseRangeX, noiseRangeY;
        if (blurOrigin == 0) {
            noiseRangeX = -random(coords.dest) * blurNoiseXValue;
            noiseRangeY = -random(coords.dest) * blurNoiseYValue;
        } else if (blurOrigin == 1) {
            noiseRangeX = (random(coords.dest) * 2.0 - 1.0) * blurNoiseXValue;
            noiseRangeY = (random(coords.dest) * 2.0 - 1.0) * blurNoiseYValue;
        } else {
            noiseRangeX = random(coords.dest) * blurNoiseXValue;
            noiseRangeY = random(coords.dest) * blurNoiseYValue;
        }
        vec2 noiseOffset = vec2(noiseRangeX, noiseRangeY) * blurDirection;
        vec2 sampleUv = coords.source + offset + noiseOffset;

        // For Cut mode, skip out-of-bounds samples entirely (no weight contribution)
        if (blurEdgeMode == 0 && !isInsideBrush(sampleUv)) continue;

        vec2 totalShift = vec2(sourceOffsetX, sourceOffsetY) + offset + noiseOffset;
        float fi = float(i);
        float gaussWeight = exp(-0.5 * (fi / sigma) * (fi / sigma));
        vec4 sampleTexel = sampleWithEdgeMode(sampleUv, coords.dest, totalShift.x, totalShift.y, blurEdgeMode);

        blurredMagL += getMag(sampleTexel.rg) * gaussWeight;
        blurredMagR += getMag(sampleTexel.ba) * gaussWeight;
        
        float samplePhaseL = getPhase(sampleTexel.rg);
        float deltaPhaseL = samplePhaseL - referencePhaseL;
        blurredPhaseL += (referencePhaseL + unwrapPhase(deltaPhaseL)) * gaussWeight;

        float samplePhaseR = getPhase(sampleTexel.ba);
        float deltaPhaseR = samplePhaseR - referencePhaseR;
        blurredPhaseR += (referencePhaseR + unwrapPhase(deltaPhaseR)) * gaussWeight;

        totalWeight += gaussWeight;
    }

    vec4 resultTexel;
    if (totalWeight > 0.0) {
        float avgMagL = blurredMagL / totalWeight;
        float avgMagR = blurredMagR / totalWeight;
        float avgPhaseL = blurredPhaseL / totalWeight;
        float avgPhaseR = blurredPhaseR / totalWeight;

        vec2 finalL = fromPolar(avgMagL, avgPhaseL);
        vec2 finalR = fromPolar(avgMagR, avgPhaseR);

        resultTexel = vec4(finalL, finalR);
    } else {
        resultTexel = originalTexel;
    }
    
    outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
