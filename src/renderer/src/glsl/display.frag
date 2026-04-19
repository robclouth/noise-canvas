#include "effect-common.glsl";

// Uniforms specific to this display material
uniform float minDb;
uniform float maxDb;
uniform float bpm;
uniform float gridSize;

uniform bool showTargetRectangle;
uniform bool showSourceRectangle;
uniform float targetRectPulse;
uniform vec3 targetRectColor;

uniform vec2 sourceBrushSizeUv; // Size of the brush in UV coordinates for the source file
uniform vec2 sourceSamplingBottomLeftUv; // Pre-computed sampling position on the source file

// Pre-calculated grid values
uniform float gridWidthUv;        // Width of each beat in UV coordinates
uniform float gridHeightUv;       // Height of each semitone in UV coordinates
uniform float barWidthUv;         // Width of each bar (4 beats) in UV coordinates
uniform float octaveHeightUv;     // Height of one octave in UV coordinates
uniform bool showHorizontalGrid;  // Whether to show horizontal grid lines
uniform bool showVerticalGrid;    // Whether to show vertical grid lines

// Scale grid (drawn at in-scale semitones when a scale is active)
uniform bool scaleGridEnabled;
uniform float scaleOffsets[12];       // signed; 0 for in-scale pitch classes
uniform float pitchOffsetSemisFromC0; // semitones above C0 at band index 0

// Convert screen UV (what we see) to zoomed UV (actual data coordinates)
vec2 screenToZoomed(vec2 screenUv, float zoomPowerX, float offsetX, float zoomPowerY, float offsetY) {
    float zx = pow(2.0, zoomPowerX);
    float zy = pow(2.0, zoomPowerY);
    float vwX = 1.0 / zx;
    float vwY = 1.0 / zy;
    float vsX = zx > 1.0 ? offsetX * (1.0 - vwX) : 0.0;
    float vsY = zy > 1.0 ? (1.0 - offsetY) * (1.0 - vwY) : 0.0;
    float x = zx > 1.0 ? vsX + screenUv.x * vwX : screenUv.x;
    float y = zy > 1.0 ? vsY + screenUv.y * vwY : screenUv.y;
    return vec2(x, y);
}

// Convert zoomed UV (actual data coordinates) to screen UV (what we see)
vec2 zoomedToScreen(vec2 zoomedUv, float zoomPowerX, float offsetX, float zoomPowerY, float offsetY) {
    float zx = pow(2.0, zoomPowerX);
    float zy = pow(2.0, zoomPowerY);
    float vwX = 1.0 / zx;
    float vwY = 1.0 / zy;
    float vsX = zx > 1.0 ? offsetX * (1.0 - vwX) : 0.0;
    float vsY = zy > 1.0 ? (1.0 - offsetY) * (1.0 - vwY) : 0.0;
    float x = zx > 1.0 ? (zoomedUv.x - vsX) / vwX : zoomedUv.x;
    float y = zy > 1.0 ? (zoomedUv.y - vsY) / vwY : zoomedUv.y;
    return vec2(x, y);
}

float magnitudeToDb(float mag) {
    float logMag = 20.0 * log(mag + 1.0e-7) / log(10.0);
    float db = (logMag - minDb) / (maxDb - minDb);
    return clamp(db, 0.0, 1.0);
}

void main() {
    // Convert screen UV to zoomed UV (actual data coordinates)
    vec2 zoomedUv = screenToZoomed(vUv, viewZoomPower, viewOffset, viewZoomPowerY, viewOffsetY);
    
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

    // Grid dots. Dots land at beat x semitone crossings; if only one axis has
    // a grid, the other is synthesized at a fixed pixel spacing so dots still
    // appear. When scale grid is active, the vertical axis uses in-scale
    // semitone positions instead of the regular semitone grid.
    bool verticalActive = scaleGridEnabled || showVerticalGrid;
    if (showHorizontalGrid || verticalActive) {
        float hThick = fwidth(zoomedUv.x);
        float vThick = fwidth(zoomedUv.y);
        float hSpacing = showHorizontalGrid ? gridWidthUv : 24.0 * hThick;
        float hLine = mod(zoomedUv.x, hSpacing);

        bool onSemi;
        if (scaleGridEnabled) {
            float bandsPerSemi = sourceBandsPerOctave / 12.0;
            float semisAboveMin = (1.0 - zoomedUv.y) * sourceBandCount / bandsPerSemi;
            float absSemis = pitchOffsetSemisFromC0 + semisAboveMin;
            float nearestSemi = floor(absSemis + 0.5);
            int pc = int(mod(nearestSemi, 12.0));
            if (scaleOffsets[pc] == 0.0) {
                float targetSemisAboveMin = nearestSemi - pitchOffsetSemisFromC0;
                float targetBandIndex = targetSemisAboveMin * bandsPerSemi;
                float targetUvY = 1.0 - targetBandIndex / sourceBandCount;
                onSemi = abs(zoomedUv.y - targetUvY) < 0.5 * vThick;
            } else {
                onSemi = false;
            }
        } else {
            float vSpacing = showVerticalGrid ? gridHeightUv : 24.0 * vThick;
            onSemi = mod(zoomedUv.y, vSpacing) < vThick;
        }

        if (hLine < hThick && onSemi) {
            bool isBar = !showHorizontalGrid || mod(zoomedUv.x, barWidthUv) < hThick;
            bool isOctave = !verticalActive || (octaveHeightUv > 0.0 && mod(zoomedUv.y, octaveHeightUv) < vThick);
            float delta = (isBar && isOctave) ? 0.5 : 0.3;
            color = mix(color + delta, color - delta, step(1.0 - delta, color));
        }
    }

    // --- Brush Area Visualization ---

    // Wrap a signed delta along an axis that wraps at 1.0 UV (tiles into [-0.5, 0.5]).
    bool wrapX = (wrapMode == 1 || wrapMode == 3);
    bool wrapY = (wrapMode == 2 || wrapMode == 3);

    // Draw source rectangle first so target renders on top when they overlap
    if (showSourceRectangle) {
        vec2 sourceCenter = sourceSamplingBottomLeftUv + sourceBrushSizeUv * 0.5;

        vec2 deltaSource = zoomedUv - sourceCenter;
        if (wrapX) deltaSource.x -= floor(deltaSource.x + 0.5);
        if (wrapY) deltaSource.y -= floor(deltaSource.y + 0.5);

        vec2 dSource = abs(deltaSource) - sourceBrushSizeUv * 0.5;
        float outsideDistSource = length(max(dSource, 0.0));
        float insideDistSource = min(max(dSource.x, dSource.y), 0.0);
        float distToBorderSource = outsideDistSource + insideDistSource;

        float sourceRectAlpha = 1.0 - smoothstep(0.0, fwidth(distToBorderSource), abs(distToBorderSource));
        // Mantine blue[6] #228be6
        color = mix(color, vec3(0.133, 0.545, 0.902), sourceRectAlpha);
    }

    // Draw target rectangle on top
    if (showTargetRectangle) {
        vec2 rectCenter = brushBottomLeftUv + brushSizeUv * 0.5;
        vec2 halfSize = brushSizeUv * 0.5;

        vec2 delta = zoomedUv - rectCenter;
        if (wrapX) delta.x -= floor(delta.x + 0.5);
        if (wrapY) delta.y -= floor(delta.y + 0.5);

        vec2 d = abs(delta) - halfSize;
        float outsideDist = length(max(d, 0.0));
        float insideDist = min(max(d.x, d.y), 0.0);
        float distToBorder = outsideDist + insideDist;

        float rectAlpha = 1.0 - smoothstep(0.0, fwidth(distToBorder), abs(distToBorder));
        color = mix(color, targetRectColor, rectAlpha * targetRectPulse);
    }

    outColor = vec4(color, 1.0);
}