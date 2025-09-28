precision highp float;
varying vec2 vUv;

#include "brush-common.glsl"

uniform Parameter shiftX;
uniform Parameter shiftY;
uniform Parameter scaleX;
uniform Parameter scaleY;
uniform Parameter rotation;
uniform int boundaryMode;

void main() {
    ProcessingUvs coords = getProcessingUvs(vUv);

    if (isInsideBrush(coords.dest)) {
        
        vec4 originalTexel = texture2D(destSpectrogramTex, vUv);

        // 1. Define the pivot point based on scale direction.
        vec2 brushHalfSize = brushSizeUv * 0.5;
        vec2 brushBottomLeft = brushCenterUv - brushHalfSize;

        vec2 pivot = brushBottomLeft;

        // 2. Translate to be relative to the pivot.
        vec2 relativeUv = coords.dest - pivot;

        // 3. Apply INVERSE Rotation around the new origin (0,0).
        float rotationValue = applyModulation(rotation.value, rotation.minValue, rotation.maxValue, rotation.modulationAmount, coords.dest);
        float rad = radians(-rotationValue);
        mat2 rotMat = mat2(cos(rad), -sin(rad), sin(rad), cos(rad));
        vec2 rotatedUv = rotMat * relativeUv;

        // 4. Apply INVERSE Scale around the new origin (0,0).
        vec2 scaledUv = rotatedUv;
        float scaleXValue = applyModulation(scaleX.value, scaleX.minValue, scaleX.maxValue, scaleX.modulationAmount, coords.dest);
        float scaleYValue = applyModulation(scaleY.value, scaleY.minValue, scaleY.maxValue, scaleY.modulationAmount, coords.dest);
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
        float shiftXValue = applyModulation(shiftX.value, shiftX.minValue, shiftX.maxValue, shiftX.modulationAmount, coords.dest);
        float shiftYValue = applyModulation(shiftY.value, shiftY.minValue, shiftY.maxValue, shiftY.modulationAmount, coords.dest);
        vec2 finalSourceUv = transformedUv - vec2(shiftXValue * sign(scaleXValue), shiftYValue * sign(scaleYValue));

        bool inBrush = isInsideBrush(finalSourceUv);

        vec4 transformedTexel  = vec4(0.0);

        bool isTimeReversed = scaleXValue < 0.0;

        if( boundaryMode == 0) { // Cut
            if(inBrush) {
                transformedTexel = getTransformedSample(finalSourceUv, coords.dest);
            } else {
                transformedTexel = vec4(0.0);
            }
        } else if(boundaryMode == 1) { // Bleed
            transformedTexel = getTransformedSample(finalSourceUv, coords.dest);
        } else if(boundaryMode == 2) { // Wrap
            // Tile the sampled region within the brush bounds
            vec2 brushBottomLeft = brushCenterUv - brushSizeUv * 0.5;
            vec2 safeSize = max(brushSizeUv, vec2(1e-6));
            vec2 local = finalSourceUv - brushBottomLeft;
            vec2 wrappedLocal = fract(local / safeSize) * safeSize;
            vec2 wrappedUv = brushBottomLeft + wrappedLocal;
            transformedTexel = getTransformedSample(wrappedUv, coords.dest);
        } else if(boundaryMode == 3) { // Ping Pong
            vec2 brushBottomLeft = brushCenterUv - brushSizeUv * 0.5;

            // Mirror (ping-pong) tiling within the brush bounds
            vec2 safeSize = max(brushSizeUv * 2.0, vec2(1e-6));
            vec2 local = finalSourceUv - brushBottomLeft;
            vec2 t = fract(local / safeSize);
            vec2 pingPong = 1.0 - abs(2.0 * t - 1.0);
            vec2 pingPongUv = brushBottomLeft + pingPong * safeSize * 0.5;

            isTimeReversed = pingPong.x < 0.5;

            transformedTexel = getTransformedSample(pingPongUv, coords.dest);
        }

        // Handle negative time scaling by flipping the phase (complex conjugate)
        if (isTimeReversed) {
            transformedTexel.g = -transformedTexel.g;
            transformedTexel.a = -transformedTexel.a;
        }

        float weight = getBrushWeight(coords.dest);
        gl_FragColor = applyBrush(originalTexel, transformedTexel, weight, coords.dest);
    } else {
        gl_FragColor = texture2D(destSpectrogramTex, vUv);
    }
}