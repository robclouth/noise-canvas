precision highp float;
varying vec2 vUv;

#include "effect-common.glsl"

uniform Parameter shiftX;
uniform Parameter shiftY;
uniform Parameter scaleX;
uniform Parameter scaleY;
uniform Parameter rotation;
uniform int boundaryMode;

void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);
    vec4 originalTexel = texture2D(destSpectrogramTex, vUv);
    float weight = getBrushWeight(coords.dest);
    if( weight <= 0.0 ) {
        gl_FragColor = originalTexel;
        return;
    } 

    // 1. Define the pivot point based on scale direction.
    vec2 brushHalfSize = brushSizeUv * 0.5;
    vec2 brushBottomLeft = brushCenterUv - brushHalfSize;

    vec2 pivot = brushBottomLeft;

    // 2. Translate to be relative to the pivot.
    // Start from coords.source which already includes sourceOffset
    vec2 relativeUv = coords.source - pivot;

    // 3. Apply INVERSE Rotation around the new origin (0,0).
    float audioLevelDb = getAudioLevelDb(coords.dest);
    float rotationValue = applyModulation(rotation.value, rotation.minValue, rotation.maxValue, rotation.modulationAmounts, coords.dest, 0, audioLevelDb);
    float rad = radians(-rotationValue);
    mat2 rotMat = mat2(cos(rad), -sin(rad), sin(rad), cos(rad));
    vec2 rotatedUv = rotMat * relativeUv;

    // 4. Apply INVERSE Scale around the new origin (0,0).
    vec2 scaledUv = rotatedUv;
    float scaleXValue = applyModulation(scaleX.value, scaleX.minValue, scaleX.maxValue, scaleX.modulationAmounts, coords.dest, 0, audioLevelDb);
    float scaleYValue = applyModulation(scaleY.value, scaleY.minValue, scaleY.maxValue, scaleY.modulationAmounts, coords.dest, 0, audioLevelDb);
    if (abs(scaleXValue) > 1e-5 && abs(scaleYValue) > 1e-5) {
        scaledUv /= vec2(scaleXValue, scaleYValue);
    }

    // 5. Translate back from the pivot's space.
    vec2 transformedUv = scaledUv + pivot;
    if(scaleXValue < 0.0) {
        transformedUv.x += brushSizeUv.x;
    }
    if(scaleYValue < 0.0) {
        transformedUv.y += brushSizeUv.y;
    }

    // 6. Apply the final shift to get the source UV to sample from.
    float rawShiftX = applyModulation(shiftX.value, shiftX.minValue, shiftX.maxValue, shiftX.modulationAmounts, coords.dest, 0, audioLevelDb);
    float rawShiftY = applyModulation(shiftY.value, shiftY.minValue, shiftY.maxValue, shiftY.modulationAmounts, coords.dest, 0, audioLevelDb);
    float appliedShiftX = -rawShiftX;
    float appliedShiftY = -rawShiftY;
    vec2 finalSourceUv = transformedUv + vec2(appliedShiftX, appliedShiftY);

    // Total shift includes both source offset and transform shift
    float totalShiftX = sourceOffsetX + appliedShiftX;
    float totalShiftY = sourceOffsetY + appliedShiftY;

    // For cut mode, we need to check if finalSourceUv is inside the source brush bounds
    // The source brush is offset from the destination brush by sourceOffset
    vec2 sourceBrushCenter = brushCenterUv + vec2(sourceOffsetX, sourceOffsetY);
    vec2 offsetFromSourceBrush = finalSourceUv - sourceBrushCenter;
    vec2 halfSize = brushSizeUv / 2.0;
    bool inSourceBrush = (brushSizeUv.x == 0.0 || abs(offsetFromSourceBrush.x) < halfSize.x) &&
                            (brushSizeUv.y == 0.0 || abs(offsetFromSourceBrush.y) < halfSize.y);

    vec4 transformedTexel  = vec4(0.0);

    bool isTimeReversed = scaleXValue < 0.0;

    if( boundaryMode == 0) { // Cut
        if(inSourceBrush) {
            transformedTexel = getTransformedSample(finalSourceUv, coords.dest, scaleXValue, scaleYValue, totalShiftX, totalShiftY);
        } else {
            transformedTexel = vec4(0.0);
        }
    } else if(boundaryMode == 1) { // Bleed
        transformedTexel = getTransformedSample(finalSourceUv, coords.dest, scaleXValue, scaleYValue, totalShiftX, totalShiftY);
    } else if(boundaryMode == 2) { // Wrap
        // Tile the sampled region within the brush bounds
        vec2 brushBottomLeft = brushCenterUv - brushSizeUv * 0.5;
        vec2 safeSize = max(brushSizeUv, vec2(1e-6));
        vec2 local = finalSourceUv - brushBottomLeft;
        vec2 wrappedLocal = fract(local / safeSize) * safeSize;
        vec2 wrappedUv = brushBottomLeft + wrappedLocal;
        transformedTexel = getTransformedSample(wrappedUv, coords.dest, scaleXValue, scaleYValue, totalShiftX, totalShiftY);
    } else if(boundaryMode == 3) { // Ping Pong
        vec2 brushBottomLeft = brushCenterUv - brushSizeUv * 0.5;

        // Mirror (ping-pong) tiling within the brush bounds
        vec2 safeSize = max(brushSizeUv * 2.0, vec2(1e-6));
        vec2 local = finalSourceUv - brushBottomLeft;
        vec2 t = fract(local / safeSize);
        vec2 pingPong = 1.0 - abs(2.0 * t - 1.0);
        vec2 pingPongUv = brushBottomLeft + pingPong * safeSize * 0.5;

        isTimeReversed = pingPong.x < 0.5;

        transformedTexel = getTransformedSample(pingPongUv, coords.dest, scaleXValue, scaleYValue, totalShiftX, totalShiftY);
    }

    // Handle negative time scaling by flipping the phase 
    if (isTimeReversed) {
        transformedTexel.g = -transformedTexel.g;
        transformedTexel.a = -transformedTexel.a;
    }

    gl_FragColor = applyBrush(originalTexel, transformedTexel, weight, coords.dest);
    
}