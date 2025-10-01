precision highp float;
varying vec2 vUv;

#include "brush-common.glsl"

uniform sampler2D harmonicsKernel;
uniform int kernelSize;

vec4 applyBrushStroke(vec4 sourceTexel, ProcessingUvs coords) {
    vec4 convolvedColor = vec4(0.0);
    int radius = kernelSize / 2;

    for (int i = -radius; i <= radius; i++) {
        // Calculate the vertical offset in UV space for the source sample
        float offsetV = float(i) / destBandCount;
        
        // Sample the source spectrogram at the offset position
        vec4 sampleColor = getSourceSample(coords.source + vec2(0.0, -offsetV));
        
        // Get the corresponding weight from the kernel texture
        float kernelUvX = (float(i) + float(radius)) / float(kernelSize);
        float kernelWeight = texture2D(harmonicsKernel, vec2(kernelUvX, 0.5)).r;
        
        convolvedColor += sampleColor * kernelWeight;
    }

    return convolvedColor;
}

#include "brush-wrapper.glsl"
