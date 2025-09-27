// This function must be implemented by the specific brush shader.
vec4 applyBrushStroke(vec4 sourceTexel, Coords coords);

void main() {
    Coords coords = getCoords(vUv);
    vec4 originalTexel = sample2d(destSpectrogramTex, coords.dest);

    if (isInBrush(coords.dest)) {
        float weight = getFeatherWeight(coords.dest);
        vec4 sourceTexel = sampleSpectrogramTransformed(coords.source, coords.dest);
        vec4 modifiedTexel = applyBrushStroke(sourceTexel, coords);
        gl_FragColor = applyBrushEffect(originalTexel, modifiedTexel, weight, coords);
    } else {
        gl_FragColor = originalTexel;
    }
}