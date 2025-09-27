// This function must be implemented by the specific brush shader.
vec4 applyBrushStroke(vec4 sourceTexel, ProcessingUvs coords);

void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);
    float weight = getBrushWeight(coords.dest);

    if (weight > 0.0) {
        vec4 originalTexel = texture2D(destSpectrogramTex, vUv);
        vec4 sourceTexel = getTransformedSample(coords.source, coords.dest);
        vec4 modifiedTexel = applyBrushStroke(sourceTexel, coords);
        gl_FragColor = applyBrush(originalTexel, modifiedTexel, weight, coords.dest);
    } else {
        gl_FragColor = texture2D(destSpectrogramTex, vUv);
    }
}