#include "effect-common.glsl";

// Uniforms specific to this display material
uniform float minDb;
uniform float maxDb;
uniform float bpm;
uniform float gridSize;

uniform bool showTargetRectangle;
uniform bool showSourceRectangle;

uniform vec2 sourceBrushSizeUv; // Size of the brush in UV coordinates for the source file
uniform vec2 sourceSamplingBottomLeftUv; // Pre-computed sampling position on the source file

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
    
    // Vertical interpolation between adjacent frequency bands, with center-aligned bins
    float bandIndexF = (1.0 - zoomedUv.y) * sourceBandCount;
    float b0 = floor(bandIndexF);
    float b1 = min(b0 + 1.0, sourceBandCount - 1.0);
    float bandFrac = fract(bandIndexF);

    vec2 uv0 = vec2(zoomedUv.x, 1.0 - (b0 + 0.5) / sourceBandCount);
    vec2 uv1 = vec2(zoomedUv.x, 1.0 - (b1 + 0.5) / sourceBandCount);

    vec4 packedValue = mix(sampleSourceInterpCentered(uv0), sampleSourceInterpCentered(uv1), bandFrac);

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
            color = fract(color + 0.3);
        }
    }
    
    // Vertical grid lines (frequency)
    if (showVerticalGrid && gridHeightUv > 0.0) {
        float verticalLine = mod(zoomedUv.y, gridHeightUv);
        float verticalLineThicknessUv = fwidth(zoomedUv.y);
        
        if (verticalLine < verticalLineThicknessUv) {
            color = fract(color + 0.3);
        }
    }

    // --- Brush Area Visualization ---

    // Draw source rectangle first so target renders on top when they overlap
    if (showSourceRectangle) {
        vec2 sourceCenter = sourceSamplingBottomLeftUv + brushSizeUv * 0.5;

        if (sourceCenter.x >= 0.0 && sourceCenter.x <= 1.0 &&
            sourceCenter.y >= 0.0 && sourceCenter.y <= 1.0) {

            vec2 dSource = abs(zoomedUv - sourceCenter) - brushSizeUv * 0.5;
            float outsideDistSource = length(max(dSource, 0.0));
            float insideDistSource = min(max(dSource.x, dSource.y), 0.0);
            float distToBorderSource = outsideDistSource + insideDistSource;

            float sourceRectAlpha = 1.0 - smoothstep(0.0, fwidth(distToBorderSource), abs(distToBorderSource));
            // Mantine blue[6] #228be6
            color = mix(color, vec3(0.133, 0.545, 0.902), sourceRectAlpha);
        }
    }

    // Draw target rectangle on top
    if (showTargetRectangle) {
        vec2 rectMin = brushBottomLeftUv;
        vec2 rectMax = brushBottomLeftUv + brushSizeUv;
        vec2 rectCenter = (rectMin + rectMax) * 0.5;
        vec2 halfSize = brushSizeUv * 0.5;

        vec2 d = abs(zoomedUv - rectCenter) - halfSize;
        float outsideDist = length(max(d, 0.0));
        float insideDist = min(max(d.x, d.y), 0.0);
        float distToBorder = outsideDist + insideDist;

        float rectAlpha = 1.0 - smoothstep(0.0, fwidth(distToBorder), abs(distToBorder));
        // Mantine orange[6] #fd7e14
        color = mix(color, vec3(0.992, 0.494, 0.078), rectAlpha);
    }

    outColor = vec4(color, 1.0);
}