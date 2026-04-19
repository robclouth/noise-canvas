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
    vec2 weight = getBrushWeight(coords.dest, audioLevelDb);
    if (weight.x <= 0.0 && weight.y <= 0.0) {
        outColor = originalTexel;
        return;
    }

    float blurredMagL = 0.0;
    float blurredMagR = 0.0;
    float blurredPhaseL = 0.0;
    float blurredPhaseR = 0.0;
    float totalWeightL = 0.0;
    float totalWeightR = 0.0;

    // Stereo-aware kernel params. When all modulators driving these have
    // stereoSpread == 0 the two components of each vec2 are equal and the
    // per-sample fast path picks the single-read branch.
    vec2 blurSizeXValue = applyModulation(blurSizeX.value, blurSizeX.minValue, blurSizeX.maxValue, blurSizeX.modulationAmounts, blurSizeX.contextualModAmounts, blurSizeX.macroAmounts, coords.dest, 0, audioLevelDb);
    vec2 blurSizeYValue = applyModulation(blurSizeY.value, blurSizeY.minValue, blurSizeY.maxValue, blurSizeY.modulationAmounts, blurSizeY.contextualModAmounts, blurSizeY.macroAmounts, coords.dest, 0, audioLevelDb);
    vec2 blurNoiseXValue = applyModulation(blurNoiseX.value, blurNoiseX.minValue, blurNoiseX.maxValue, blurNoiseX.modulationAmounts, blurNoiseX.contextualModAmounts, blurNoiseX.macroAmounts, coords.dest, 0, audioLevelDb);
    vec2 blurNoiseYValue = applyModulation(blurNoiseY.value, blurNoiseY.minValue, blurNoiseY.maxValue, blurNoiseY.modulationAmounts, blurNoiseY.contextualModAmounts, blurNoiseY.macroAmounts, coords.dest, 0, audioLevelDb);

    bool sameKernel = (blurSizeXValue.x == blurSizeXValue.y)
                   && (blurSizeYValue.x == blurSizeYValue.y)
                   && (blurNoiseXValue.x == blurNoiseXValue.y)
                   && (blurNoiseYValue.x == blurNoiseYValue.y)
                   && coords.sameSourceUv;

    vec2 blurSizeUvL = vec2(blurSizeXValue.x, blurSizeYValue.x);
    vec2 blurSizeUvR = vec2(blurSizeXValue.y, blurSizeYValue.y);

    vec4 sourceCenterTexelL = getTransformedSample(coords.sourceL, coords.dest, sourceTimeScale, sourceBandScale, sourceOffsetX, sourceOffsetY);
    float referencePhaseL = getPhase(sourceCenterTexelL.rg);
    float referencePhaseR;
    if (sameKernel) {
        referencePhaseR = getPhase(sourceCenterTexelL.ba);
    } else {
        vec4 sourceCenterTexelR = getTransformedSample(coords.sourceR, coords.dest, sourceTimeScale, sourceBandScale, sourceOffsetX, sourceOffsetY);
        referencePhaseR = getPhase(sourceCenterTexelR.ba);
    }

    // radius = half the sample count; sigma scaled so 3-sigma covers the radius
    int radius = blurSampleCount / 2;
    float sigma = float(max(radius, 1)) / 3.0;

    // Loop up to the max possible sample count (64), breaking early once all samples are processed
    for (int s = 0; s < 64; s++) {
        if (s >= blurSampleCount) break;

        int i = s - radius;

        if (blurOrigin == 0 && i > 0) continue; // Left: causal, no future samples
        if (blurOrigin == 2 && i < 0) continue; // Right: anti-causal, no past samples

        float fi = float(i);
        float gaussWeight = exp(-0.5 * (fi / sigma) * (fi / sigma));

        // Noise direction follows origin mode. Shared seed for L/R so the random
        // draw matches across channels; kernel widths scale the magnitude.
        float rndN = random(coords.dest);
        float rndS = blurOrigin == 1 ? (rndN * 2.0 - 1.0) : (blurOrigin == 0 ? -rndN : rndN);

        vec2 offsetL = blurDirection * fi * blurSizeUvL / float(max(radius, 1));
        vec2 noiseOffsetL = vec2(rndS * blurNoiseXValue.x, rndS * blurNoiseYValue.x) * blurDirection;
        vec2 sampleUvL = coords.sourceL + offsetL + noiseOffsetL;

        vec2 offsetR, noiseOffsetR, sampleUvR;
        if (sameKernel) {
            offsetR = offsetL;
            noiseOffsetR = noiseOffsetL;
            sampleUvR = sampleUvL;
        } else {
            offsetR = blurDirection * fi * blurSizeUvR / float(max(radius, 1));
            noiseOffsetR = vec2(rndS * blurNoiseXValue.y, rndS * blurNoiseYValue.y) * blurDirection;
            sampleUvR = coords.sourceR + offsetR + noiseOffsetR;
        }

        // Cut mode: each channel contributes only if its own sample position
        // (noise-inclusive) falls inside the brush. Skip the iteration only
        // when both are out.
        bool inL = blurEdgeMode != 0 || isInsideBrush(sampleUvL);
        bool inR = sameKernel ? inL : (blurEdgeMode != 0 || isInsideBrush(sampleUvR));
        if (!inL && !inR) continue;

        vec4 sampleTexelL = inL
            ? sampleWithEdgeMode(sampleUvL, coords.dest, sourceOffsetX + offsetL.x + noiseOffsetL.x, sourceOffsetY + offsetL.y + noiseOffsetL.y, blurEdgeMode)
            : vec4(0.0);
        vec4 sampleTexelR;
        if (sameKernel) {
            sampleTexelR = sampleTexelL;
        } else if (inR) {
            sampleTexelR = sampleWithEdgeMode(sampleUvR, coords.dest, sourceOffsetX + offsetR.x + noiseOffsetR.x, sourceOffsetY + offsetR.y + noiseOffsetR.y, blurEdgeMode);
        } else {
            sampleTexelR = vec4(0.0);
        }

        if (inL) {
            blurredMagL += getMag(sampleTexelL.rg) * gaussWeight;
            float samplePhaseL = getPhase(sampleTexelL.rg);
            float deltaPhaseL = samplePhaseL - referencePhaseL;
            blurredPhaseL += (referencePhaseL + unwrapPhase(deltaPhaseL)) * gaussWeight;
            totalWeightL += gaussWeight;
        }
        if (inR) {
            blurredMagR += getMag(sampleTexelR.ba) * gaussWeight;
            float samplePhaseR = getPhase(sampleTexelR.ba);
            float deltaPhaseR = samplePhaseR - referencePhaseR;
            blurredPhaseR += (referencePhaseR + unwrapPhase(deltaPhaseR)) * gaussWeight;
            totalWeightR += gaussWeight;
        }
    }

    vec4 resultTexel;
    if (totalWeightL > 0.0 || totalWeightR > 0.0) {
        vec2 finalL = totalWeightL > 0.0
            ? fromPolar(blurredMagL / totalWeightL, blurredPhaseL / totalWeightL)
            : originalTexel.rg;
        vec2 finalR = totalWeightR > 0.0
            ? fromPolar(blurredMagR / totalWeightR, blurredPhaseR / totalWeightR)
            : originalTexel.ba;
        resultTexel = vec4(finalL, finalR);
    } else {
        resultTexel = originalTexel;
    }
    
    outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
