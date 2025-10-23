precision highp float;
varying vec2 vUv;

#include "effect-common.glsl";

// Uniforms specific to this display material
uniform float minDb;
uniform float maxDb;
uniform float bpm;
uniform float gridSize;

uniform bool showTargetRectangle;
uniform bool showSourceRectangle;

// Pre-calculated grid values
uniform float gridWidthUv;        // Width of each beat in UV coordinates
uniform float gridHeightUv;       // Height of each semitone in UV coordinates
uniform float barWidthUv;         // Width of each bar (4 beats) in UV coordinates
uniform bool showHorizontalGrid;  // Whether to show horizontal grid lines
uniform bool showVerticalGrid;    // Whether to show vertical grid lines

// Convert screen UV (what we see) to zoomed UV (actual data coordinates)
vec2 screenToZoomed(vec2 screenUv, float zoomPower, float offset) {
    float zoom = pow(2.0, zoomPower);
    if (zoom <= 1.0) {
        return screenUv;
    }
    float viewWidth = 1.0 / zoom;
    float viewStartX = offset * (1.0 - viewWidth);
    return vec2(viewStartX + screenUv.x * viewWidth, screenUv.y);
}

// Convert zoomed UV (actual data coordinates) to screen UV (what we see)
vec2 zoomedToScreen(vec2 zoomedUv, float zoomPower, float offset) {
    float zoom = pow(2.0, zoomPower);
    if (zoom <= 1.0) {
        return zoomedUv;
    }
    float viewWidth = 1.0 / zoom;
    float viewStartX = offset * (1.0 - viewWidth);
    return vec2((zoomedUv.x - viewStartX) / viewWidth, zoomedUv.y);
}

float magnitudeToDb(float mag) {
    float logMag = 20.0 * log(mag + 1.0e-7) / log(10.0);
    float db = (logMag - minDb) / (maxDb - minDb);
    return clamp(db, 0.0, 1.0);
}

void main() {
    // Convert screen UV to zoomed UV (actual data coordinates)
    vec2 zoomedUv = screenToZoomed(vUv, viewZoomPower, viewOffset);
    
    vec4 packedValue = sampleSourceInterpCentered(zoomedUv);

    // packedValue stores [leftMagnitude, leftPhase, rightMagnitude, rightPhase]
    vec2 leftMagPhase = packedValue.rg;
    float leftMag = leftMagPhase.x;
    float leftDb = magnitudeToDb(leftMag);
    
    vec3 color;
    if (sourceChannelCount == 1) {
        color = vec3(leftDb);
    } else {
        vec2 rightMagPhase = packedValue.ba;
        float rightMag = rightMagPhase.x;
        float rightDb = magnitudeToDb(rightMag);
        
        vec3 leftColor = vec3(leftDb, leftDb * 0.5, 0.0);
        vec3 rightColor = vec3(0.0, rightDb * 0.5, rightDb);
        color = leftColor + rightColor;
    }

    // Grid lines (in zoomed coordinates)
    float lineThicknessUv = fwidth(zoomedUv.x);
    
    // Horizontal grid lines (time)
    if (showHorizontalGrid) {
        float line = mod(zoomedUv.x, gridWidthUv);
        
        // Check if this is the first beat of a bar (4/4 timing)
        float barLine = mod(zoomedUv.x, barWidthUv);
        bool isBarStart = barLine < gridWidthUv;
        
        if (line < lineThicknessUv) {
            // Invert color with subtle contrast
            float strength = isBarStart ? 0.35 : 0.25;
            vec3 inverted = vec3(1.0) - color;
            // Push inverted color away from middle gray for better visibility
            inverted = inverted * 1.3 - 0.15;
            inverted = clamp(inverted, 0.0, 1.0);
            color = mix(color, inverted, strength);
        }
    }
    
    // Vertical grid lines (frequency)
    if (showVerticalGrid && gridHeightUv > 0.0) {
        float verticalLine = mod(zoomedUv.y, gridHeightUv);
        float verticalLineThicknessUv = fwidth(zoomedUv.y);
        
        if (verticalLine < verticalLineThicknessUv) {
            // Invert color with subtle contrast
            vec3 inverted = vec3(1.0) - color;
            // Push inverted color away from middle gray for better visibility
            inverted = inverted * 1.3 - 0.15;
            inverted = clamp(inverted, 0.0, 1.0);
            color = mix(color, inverted, 0.25);
        }
    }

    // --- Brush Area Visualization ---

    // Common calculations for both rectangles
    // Brush center is already in zoomed coordinates
    vec2 rectCenter = brushCenterUv;
    
    vec2 correctedRectCenter = rectCenter;
    vec2 correctedBrushSize = brushSizeUv;
    
    vec2 halfSize = correctedBrushSize / 2.0;
    float strokeWidthUv = fwidth(zoomedUv.x) * 1.5;

    // Draw Brush Area Rectangle (only if this is the active file)
    if (showTargetRectangle) {
        vec2 d = abs(zoomedUv - correctedRectCenter) - halfSize;
        float outsideDist = length(max(d, 0.0));
        float insideDist = min(max(d.x, d.y), 0.0);
        float distToBorder = outsideDist + insideDist;

        float rectAlpha = 1.0 - smoothstep(0.0, strokeWidthUv, abs(distToBorder));
        if (rectAlpha > 0.0) {
            // Invert color with enhanced contrast
            vec3 inverted = vec3(1.0) - color;
            inverted = inverted * 1.5 - 0.25;
            inverted = clamp(inverted, 0.0, 1.0);
            color = mix(color, inverted, rectAlpha);
        }
    }

    if (showSourceRectangle) {
        // Draw source rectangle (faint)
        vec2 effectiveOffset = vec2(sourceOffsetX, sourceOffsetY);

        vec2 sourceCenter = correctedRectCenter + effectiveOffset;
        vec2 sourceCenterScreen = sourceCenter;

        if (sourceCenterScreen.x >= 0.0 && sourceCenterScreen.x <= 1.0 &&
            sourceCenterScreen.y >= 0.0 && sourceCenterScreen.y <= 1.0) {
            
            vec2 dSource = abs(zoomedUv - sourceCenter) - halfSize; // reuse halfSize from brush rect
            float outsideDistSource = length(max(dSource, 0.0));
            float insideDistSource = min(max(dSource.x, dSource.y), 0.0);
            float distToBorderSource = outsideDistSource + insideDistSource;

            float sourceRectAlpha = 1.0 - smoothstep(0.0, strokeWidthUv, abs(distToBorderSource));
            if (sourceRectAlpha > 0.0) {
                // Invert color with enhanced contrast (fainter for source)
                vec3 inverted = vec3(1.0) - color;
                inverted = inverted * 1.5 - 0.25;
                inverted = clamp(inverted, 0.0, 1.0);
                color = mix(color, inverted, sourceRectAlpha * 0.3);
            }
        }
    }

    gl_FragColor = vec4(color, 1.0);
}