precision highp float;
varying vec2 vUv;

#include "brush-common.glsl"

uniform Parameter sharpenAmountX;
uniform Parameter sharpenAmountY;
uniform vec2 sharpenDirection; // (1, 0) for horizontal, (0, 1) for vertical

const int KERNEL_RADIUS = 2;

void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);
    vec4 originalTexel = texture2D(destSpectrogramTex, vUv);

    if (isInsideBrush(coords.dest)) {
        float sharpenedMagL = 0.0;
        float sharpenedMagR = 0.0;
        float sharpenedPhaseL = 0.0;
        float sharpenedPhaseR = 0.0;
        
        vec4 sourceCenterTexel = getTransformedSample(coords.source, coords.dest);
        float referencePhaseL = getPhase(sourceCenterTexel.rg);
        float referencePhaseR = getPhase(sourceCenterTexel.ba);

        float sharpenAmountXValue = applyModulation(sharpenAmountX.value, sharpenAmountX.minValue, sharpenAmountX.maxValue, sharpenAmountX.modulationAmount, coords.dest);
        float sharpenAmountYValue = applyModulation(sharpenAmountY.value, sharpenAmountY.minValue, sharpenAmountY.maxValue, sharpenAmountY.modulationAmount, coords.dest);

        float sharpenAmount = sharpenDirection.x > 0.0 ? sharpenAmountXValue : sharpenAmountYValue;
        
        // Sharpening kernel: [-amount, 1 + 2 * amount, -amount]
        // To simplify, we can think of it as:
        // center * (1 + 2 * amount) - (neighbor1 + neighbor2) * amount
        // which is equivalent to:
        // center + (center - (neighbor1 + neighbor2)) * amount
        // Let's use a simpler one for now: (center * 3.0 - n1 - n2)
        // A classic sharpening kernel is [-1, 3, -1] for 1D.
        // Let's make it strength-dependent.
        // kernel will be [-amount, 1+2*amount, -amount]. The sum is 1.

        float totalWeight = 0.0;

        for (int i = -KERNEL_RADIUS; i <= KERNEL_RADIUS; i++) {
            vec2 offset = sharpenDirection * float(i) * 0.05 * vec2(sharpenAmountXValue, sharpenAmountYValue) / float(KERNEL_RADIUS);
            vec2 sampleUv = coords.source + offset;
            
            float weight;
            if (i == 0) {
                weight = 1.0 + 2.0 * sharpenAmount;
            } else {
                weight = -sharpenAmount;
            }

            vec4 sampleTexel = getTransformedSample(sampleUv, coords.dest);
            
            sharpenedMagL += getMag(sampleTexel.rg) * weight;
            sharpenedMagR += getMag(sampleTexel.ba) * weight;
            
            float samplePhaseL = getPhase(sampleTexel.rg);
            float deltaPhaseL = samplePhaseL - referencePhaseL;
            sharpenedPhaseL += (referencePhaseL + unwrapPhase(deltaPhaseL)) * weight;

            float samplePhaseR = getPhase(sampleTexel.ba);
            float deltaPhaseR = samplePhaseR - referencePhaseR;
            sharpenedPhaseR += (referencePhaseR + unwrapPhase(deltaPhaseR)) * weight;
            
            totalWeight += weight;
        }

        vec4 resultTexel;

        float avgMagL = sharpenedMagL;
        float avgMagR = sharpenedMagR;
        float avgPhaseL = sharpenedPhaseL;
        float avgPhaseR = sharpenedPhaseR;

        vec2 finalL = fromPolar(avgMagL, avgPhaseL);
        vec2 finalR = fromPolar(avgMagR, avgPhaseR);

        resultTexel = vec4(finalL, finalR);
        
        float weight = getBrushWeight(coords.dest);
        gl_FragColor = applyBrush(originalTexel, resultTexel, weight, coords.dest);
    } else {
        gl_FragColor = originalTexel;
    }
}
