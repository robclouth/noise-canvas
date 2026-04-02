// This function must be implemented by the specific brush shader.
vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb);

void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);
    vec4 originalTexel = texture(destSpectrogramTex, vUv);
    float weight = getBrushWeight(coords.dest);
    if(weight <= 0.0) {
        outColor = originalTexel;
        return;
    } 

    vec4 sourceTexel = getTransformedSample(coords.source, coords.dest, sourceTimeScale, sourceBandScale, sourceOffsetX, sourceOffsetY);
    float audioLevelDb = getAudioLevelDb(coords.dest);
    vec4 modifiedTexel = applyEffectStroke(sourceTexel, coords, audioLevelDb);
    outColor = applyBrush(originalTexel, modifiedTexel, weight, coords.dest, vUv);
}