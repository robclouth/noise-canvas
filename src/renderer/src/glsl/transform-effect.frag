#include "effect-common.glsl"
#include "edge-mode.glsl"

uniform Parameter shiftX;
uniform Parameter shiftY;
uniform Parameter scaleX;
uniform Parameter scaleY;
uniform Parameter rotation;
uniform int boundaryMode;

uniform bool scaleSnapEnabled;
uniform float scaleOffsets[12];
uniform float brushBasePitchAbsSemis;

// Snap a pitch in semitones to the nearest in-scale semitone. Considers both the
// floor and ceil chromatic neighbors so values near boundaries pick the truly-closest
// scale note.
float snapToScale(float target) {
    float chromaLow = floor(target);
    float chromaHigh = chromaLow + 1.0;
    int pcLow = int(mod(chromaLow, 12.0));
    int pcHigh = int(mod(chromaHigh, 12.0));
    float candLow = chromaLow + scaleOffsets[pcLow];
    float candHigh = chromaHigh + scaleOffsets[pcHigh];
    return (abs(candLow - target) <= abs(candHigh - target)) ? candLow : candHigh;
}

void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);
    vec4 originalTexel = texture(destSpectrogramTex, vUv);
    float audioLevelDb = getAudioLevelDb(coords.dest);
    vec2 weight = getBrushWeight(coords.dest, audioLevelDb);
    if (weight.x <= 0.0 && weight.y <= 0.0) {
        outColor = originalTexel;
        return;
    }

    // 1. Define the pivot point based on scale direction (bottom-left corner).
    vec2 pivot = brushBottomLeftUv;

    // Resolve the geometric params as vec2 (L, R). When all modulators driving
    // them have stereoSpread == 0, .x == .y and the fast path below kicks in.
    bool used[NUM_MODULATORS];
    for (int _mi = 0; _mi < NUM_MODULATORS; _mi++) {
      used[_mi] = (rotation.modulationAmounts[_mi] != 0.0) || (scaleX.modulationAmounts[_mi] != 0.0) || (scaleY.modulationAmounts[_mi] != 0.0) || (shiftX.modulationAmounts[_mi] != 0.0) || (shiftY.modulationAmounts[_mi] != 0.0);
    }
    vec2 mods[NUM_MODULATORS];
    evalModulators(coords.dest, 0, audioLevelDb, used, mods);
    vec2 rotationValue = applyModulationCached(rotation.value, rotation.minValue, rotation.maxValue, rotation.modulationAmounts, rotation.contextualModAmounts, rotation.macroAmounts, mods);
    vec2 scaleXValue = applyModulationCached(scaleX.value, scaleX.minValue, scaleX.maxValue, scaleX.modulationAmounts, scaleX.contextualModAmounts, scaleX.macroAmounts, mods);
    vec2 scaleYValue = applyModulationCached(scaleY.value, scaleY.minValue, scaleY.maxValue, scaleY.modulationAmounts, scaleY.contextualModAmounts, scaleY.macroAmounts, mods);
    vec2 rawShiftX = applyModulationCached(shiftX.value, shiftX.minValue, shiftX.maxValue, shiftX.modulationAmounts, shiftX.contextualModAmounts, shiftX.macroAmounts, mods);
    vec2 rawShiftY = applyModulationCached(shiftY.value, shiftY.minValue, shiftY.maxValue, shiftY.modulationAmounts, shiftY.contextualModAmounts, shiftY.macroAmounts, mods);

    bool sameParams = (rotationValue.x == rotationValue.y)
                   && (scaleXValue.x == scaleXValue.y)
                   && (scaleYValue.x == scaleYValue.y)
                   && (rawShiftX.x == rawShiftX.y)
                   && (rawShiftY.x == rawShiftY.y)
                   && coords.sameSourceUv;

    float bandsPerSemi = destBandsPerOctave / 12.0;

    // Computes the transformed source UV and effective scale for one channel
    // given its source UV (coords.sourceL or coords.sourceR) and its channel's
    // scalar params. Returns the sample to write into that channel.
    #define COMPUTE_CHANNEL(outTexel, srcUv, rotV, sxV, syV, shXV, shYV) { \
        vec2 relativeUv = srcUv - pivot; \
        float rad = radians(-(rotV)); \
        mat2 rotMat = mat2(cos(rad), -sin(rad), sin(rad), cos(rad)); \
        vec2 scaledUv = rotMat * relativeUv; \
        if (abs(sxV) > 1e-5 && abs(syV) > 1e-5) { scaledUv /= vec2(sxV, syV); } \
        vec2 transformedUv = scaledUv + pivot; \
        if ((sxV) < 0.0) transformedUv.x += brushSizeUv.x; \
        if ((syV) < 0.0) transformedUv.y += brushSizeUv.y; \
        float appliedShiftX = -(shXV); \
        float shiftSemisApplied = -(shYV) * destBandCount / bandsPerSemi; \
        if (scaleSnapEnabled) { \
            float target = brushBasePitchAbsSemis + shiftSemisApplied; \
            shiftSemisApplied += snapToScale(target) - target; \
        } \
        float appliedShiftY = shiftSemisApplied * bandsPerSemi / destBandCount; \
        vec2 finalSourceUv = transformedUv + vec2(appliedShiftX, appliedShiftY); \
        float totalShiftX = sourceOffsetX + appliedShiftX; \
        float totalShiftY = sourceOffsetY + appliedShiftY; \
        bool useZero, invertSample; \
        vec2 edgeUv = applyEdgeMode(finalSourceUv, boundaryMode, useZero, invertSample); \
        if (useZero) { \
            outTexel = vec4(0.0); \
        } else { \
            /* Reflect-mode flourish: on odd-parity tiles flip scaleX so content */ \
            /* reads as a true mirror image rather than sliding past the boundary. */ \
            /* Parity is taken in dest UV (where the brush lives), pre-remap. */ \
            float effScaleX = (sxV); \
            if (boundaryMode == 4 && brushSizeUv.x > 0.0) { \
                vec2 finalDestUv = sourceUvToDestUv(finalSourceUv); \
                float parityX = mod(floor((finalDestUv.x - brushBottomLeftUv.x) / brushSizeUv.x), 2.0); \
                if (parityX > 0.5) effScaleX = -effScaleX; \
            } \
            vec4 result = getTransformedSample(edgeUv, coords.dest, effScaleX, (syV), totalShiftX, totalShiftY); \
            outTexel = invertSample ? -result : result; \
        } \
    }

    vec4 transformedTexel;
    if (sameParams) {
        COMPUTE_CHANNEL(transformedTexel, coords.source, rotationValue.x, scaleXValue.x, scaleYValue.x, rawShiftX.x, rawShiftY.x)
    } else {
        vec4 texL;
        vec4 texR;
        COMPUTE_CHANNEL(texL, coords.sourceL, rotationValue.x, scaleXValue.x, scaleYValue.x, rawShiftX.x, rawShiftY.x)
        COMPUTE_CHANNEL(texR, coords.sourceR, rotationValue.y, scaleXValue.y, scaleYValue.y, rawShiftX.y, rawShiftY.y)
        transformedTexel = vec4(texL.rg, texR.ba);
    }

    outColor = applyBrush(originalTexel, transformedTexel, weight, coords.dest, vUv);
}