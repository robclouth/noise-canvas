// This function must be implemented by the specific brush shader.
vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb);

void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);

    if (isInsideBrush(coords.dest)) {
        vec4 originalTexel = texture2D(destSpectrogramTex, vUv);
        vec4 sourceTexel = getTransformedSample(coords.source, coords.dest);
        float audioLevelDb = getAudioLevelDb(coords.dest);
        vec4 modifiedTexel = applyEffectStroke(sourceTexel, coords, audioLevelDb);
        float weight = getBrushWeight(coords.dest);
        gl_FragColor = applyBrush(originalTexel, modifiedTexel, weight, coords.dest);
    } else {
        gl_FragColor = texture2D(destSpectrogramTex, vUv);
    }
}