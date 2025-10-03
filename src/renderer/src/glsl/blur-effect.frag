precision highp float;
varying vec2 vUv;

#include "effect-common.glsl"

uniform Parameter blurSizeX;
uniform Parameter blurSizeY;
uniform Parameter blurNoiseX;
uniform Parameter blurNoiseY;
uniform vec2 blurDirection; // (1, 0) for horizontal, (0, 1) for vertical
uniform bool bleed;

const int KERNEL_RADIUS = 8;
const int KERNEL_SIZE = KERNEL_RADIUS * 2 + 1;
const float gaussianKernel[KERNEL_SIZE] = float[](
    0.0009, 0.0028, 0.0075, 0.0177, 0.0371, 0.0685, 0.1112, 0.1585, 0.1993, 0.1585, 0.1112, 0.0685, 0.0371, 0.0177, 0.0075, 0.0028, 0.0009
);


void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);
    vec4 originalTexel = texture2D(destSpectrogramTex, vUv);

    if (isInsideBrush(coords.dest)) {
        float blurredMagL = 0.0;
        float blurredMagR = 0.0;
        float blurredPhaseL = 0.0;
        float blurredPhaseR = 0.0;
        float totalWeight = 0.0;
        
        vec4 sourceCenterTexel = getTransformedSample(coords.source, coords.dest);
        float referencePhaseL = getPhase(sourceCenterTexel.rg);
        float referencePhaseR = getPhase(sourceCenterTexel.ba);

        float blurSizeXValue = applyModulation(blurSizeX.value, blurSizeX.minValue, blurSizeX.maxValue, blurSizeX.modulationAmounts, coords.dest, 0);
        float blurSizeYValue = applyModulation(blurSizeY.value, blurSizeY.minValue, blurSizeY.maxValue, blurSizeY.modulationAmounts, coords.dest, 0);
        float blurNoiseXValue = applyModulation(blurNoiseX.value, blurNoiseX.minValue, blurNoiseX.maxValue, blurNoiseX.modulationAmounts, coords.dest, 0);
        float blurNoiseYValue = applyModulation(blurNoiseY.value, blurNoiseY.minValue, blurNoiseY.maxValue, blurNoiseY.modulationAmounts, coords.dest, 0);

        vec2 blurSizeUv = vec2(blurSizeXValue, blurSizeYValue);

        for (int i = -KERNEL_RADIUS; i <= KERNEL_RADIUS; i++) {
            vec2 offset = blurDirection * float(i) * blurSizeUv / float(KERNEL_RADIUS);
            vec2 noiseOffset = vec2((random(coords.dest) * 2.0 - 1.0) * blurNoiseXValue, (random(coords.dest) * 2.0 - 1.0) * blurNoiseYValue) * blurDirection;
            vec2 sampleUv = coords.source + offset + noiseOffset;
            
            if (bleed || isInsideBrush(sampleUv)) {
                float weight = gaussianKernel[i + KERNEL_RADIUS];
                vec4 sampleTexel = getTransformedSample(sampleUv, coords.dest);
                
                blurredMagL += getMag(sampleTexel.rg) * weight;
                blurredMagR += getMag(sampleTexel.ba) * weight;
                
                float samplePhaseL = getPhase(sampleTexel.rg);
                float deltaPhaseL = samplePhaseL - referencePhaseL;
                blurredPhaseL += (referencePhaseL + unwrapPhase(deltaPhaseL)) * weight;

                float samplePhaseR = getPhase(sampleTexel.ba);
                float deltaPhaseR = samplePhaseR - referencePhaseR;
                blurredPhaseR += (referencePhaseR + unwrapPhase(deltaPhaseR)) * weight;

                totalWeight += weight;
            }
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
        
        float weight = getBrushWeight(coords.dest);
        gl_FragColor = applyBrush(originalTexel, resultTexel, weight, coords.dest);
    } else {
        gl_FragColor = originalTexel;
    }
}
