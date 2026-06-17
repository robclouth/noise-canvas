// This function must be implemented by the specific brush shader.
vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb);

void main() {
    vec2 destUv = packedToUnpackedUv(destInverseMapTex, vUv, destFrameCount, destBandCount);
    if (brushWeightIsZero(destUv)) {
        outColor = texture(destSpectrogramTex, vUv);
        return;
    }
    ProcessingUvs coords = getProcessingUvs(vUv);
    vec4 originalTexel = texture(destSpectrogramTex, vUv);
    float audioLevelDb = getAudioLevelDb(coords.dest);
    vec2 weight = getBrushWeight(coords.dest, audioLevelDb);
    if(weight.x <= 0.0 && weight.y <= 0.0) {
        outColor = originalTexel;
        return;
    }

    // Fast path: one read when source UVs match across channels. When they
    // differ, sample twice and take each channel's half of the result.
    vec4 sourceTexel;
    if (coords.sameSourceUv) {
        sourceTexel = getTransformedSample(coords.source, coords.dest, sourceTimeScale, sourceBandScale, sourceOffsetX, sourceOffsetY);
    } else {
        vec4 sL = getTransformedSample(coords.sourceL, coords.dest, sourceTimeScale, sourceBandScale, sourceOffsetX, sourceOffsetY);
        vec4 sR = getTransformedSample(coords.sourceR, coords.dest, sourceTimeScale, sourceBandScale, sourceOffsetX, sourceOffsetY);
        sourceTexel = vec4(sL.rg, sR.ba);
    }
    vec4 modifiedTexel = applyEffectStroke(sourceTexel, coords, audioLevelDb);
    outColor = applyBrush(originalTexel, modifiedTexel, weight, coords.dest, vUv);
}