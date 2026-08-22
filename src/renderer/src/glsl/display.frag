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
uniform float swingOffsetUv;      // Offset applied to odd-indexed grid lines (UV)
uniform bool showHorizontalGrid;  // Whether to show horizontal grid lines
uniform bool showVerticalGrid;    // Whether to show vertical grid lines

// Scale grid (drawn at in-scale semitones when a scale is active)
uniform bool scaleGridEnabled;
uniform float scaleOffsets[12];       // signed; 0 for in-scale pitch classes
uniform float pitchOffsetSemisFromC0; // semitones above C0 at band index 0

// Absolute level calibration. The analysis applies no amplitude normalization,
// so this offset is what turns a raw coefficient magnitude into dBFS.
uniform float fullScaleDbOffset;

// The brush preview, valid only in packed rows [previewRowStart, previewRowEnd);
// every other row is read from the committed spectrogram. An empty range
// shows the committed spectrogram alone.
uniform sampler2D previewTex;
uniform int previewRowStart;
uniform int previewRowEnd;

vec4 fetchDisplayTexel(ivec2 texel) {
    if (texel.y >= previewRowStart && texel.y < previewRowEnd) return texelFetch(previewTex, texel, 0);
    return texelFetch(sourceSpectrogramTex, texel, 0);
}

vec4 sampleDisplayInterp(vec2 uv) {
    ivec2 texel1, texel2;
    float timeFraction;
    packedInterpCoords(uv, sourceMetadataTex, sourceFrameCount, sourceBandCount,
                       textureSize(sourceSpectrogramTex, 0), texel1, texel2, timeFraction);
    vec4 sample1 = fetchDisplayTexel(texel1);
    vec4 sample2 = fetchDisplayTexel(texel2);
    return vec4(interpolateComplex(sample1.rg, sample2.rg, timeFraction),
                interpolateComplex(sample1.ba, sample2.ba, timeFraction));
}

// Convert screen UV (what we see) to zoomed UV (actual data coordinates).
// screenUv.y and the result are pitch UV — 0 at the file's lowest band — but
// offsetY arrives in the view space the DOM pans in, y measured down from the
// top of the lane, so it is flipped here.
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

// Absolute level of a coefficient, in dB relative to full scale.
float magnitudeToDbfs(float mag) {
    return 20.0 * log(mag + 1.0e-7) / log(10.0) + fullScaleDbOffset;
}

// Normalized display intensity in [0, 1] across the visible dB window.
float magnitudeToDb(float mag) {
    float db = (magnitudeToDbfs(mag) - minDb) / (maxDb - minDb);
    return clamp(db, 0.0, 1.0);
}

void main() {
    // Convert screen UV to zoomed UV (actual data coordinates)
    vec2 zoomedUv = screenToZoomed(vUv, viewZoomPower, viewOffset, viewZoomPowerY, viewOffsetY);
    
    // Vertical interpolation between adjacent frequency bands. A band's row is
    // the strip [b/N, (b+1)/N], so its pure value renders at the strip center
    // (bandIndexF lands on an integer there) and blends toward its neighbours
    // at the strip edges.
    float bandIndexF = (1.0 - zoomedUv.y) * sourceBandCount - 0.5;
    float b0 = clamp(floor(bandIndexF), 0.0, sourceBandCount - 1.0);
    float b1 = min(b0 + 1.0, sourceBandCount - 1.0);
    float bandFrac = clamp(bandIndexF - b0, 0.0, 1.0);

    vec2 uv0 = vec2(zoomedUv.x, 1.0 - (b0 + 0.5) / sourceBandCount);
    vec2 uv1 = vec2(zoomedUv.x, 1.0 - (b1 + 0.5) / sourceBandCount);

    // Time axis samples edge-aligned: the stored coefficient for bin k is the
    // analysis atom centered at frame k * 2^step, so an impulse reads as a
    // vertical ridge at the same time in every band regardless of bin stride.
    vec4 packedValue = mix(sampleDisplayInterp(uv0), sampleDisplayInterp(uv1), bandFrac);

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

    // Faint grid lines. Adaptive contrast (brighten by delta, or darken if that
    // would clip past 1.0) so lines stay visible on any background. The delta
    // is scaled up in dark regions to compensate for sRGB gamma — a fixed
    // additive bump on near-black reads much fainter than the same bump on
    // mid-gray. Bar/octave boundaries get a slightly stronger delta.
    float hThick = fwidth(zoomedUv.x);
    float vThick = fwidth(zoomedUv.y);
    float brightness = max(color.r, max(color.g, color.b));
    float contrastBoost = mix(2.0, 1.0, brightness);
    float lineDelta = 0.045 * contrastBoost;
    float strongDelta = 0.1 * contrastBoost;

    if (showHorizontalGrid && gridWidthUv > 0.0) {
        float pairWidth = gridWidthUv * 2.0;
        float xInPair = mod(zoomedUv.x, pairWidth);
        float oddLineInPair = gridWidthUv + swingOffsetUv;
        bool onEven = xInPair < hThick || xInPair > pairWidth - hThick;
        bool onOdd = abs(xInPair - oddLineInPair) < hThick;
        if (onEven || onOdd) {
            bool isBar = onEven && mod(zoomedUv.x, barWidthUv) < hThick;
            float d = isBar ? strongDelta : lineDelta;
            color = mix(color + d, color - d, step(1.0 - d, color));
        }
    }

    if (scaleGridEnabled) {
        float bandsPerSemi = sourceBandsPerOctave / 12.0;
        float semisAboveMin = zoomedUv.y * sourceBandCount / bandsPerSemi;
        float absSemis = pitchOffsetSemisFromC0 + semisAboveMin;
        float nearestSemi = floor(absSemis + 0.5);
        int pc = int(mod(nearestSemi, 12.0));
        if (scaleOffsets[pc] == 0.0) {
            float targetSemisAboveMin = nearestSemi - pitchOffsetSemisFromC0;
            float targetBandIndex = targetSemisAboveMin * bandsPerSemi;
            float targetUvY = targetBandIndex / sourceBandCount;
            if (abs(zoomedUv.y - targetUvY) < 0.5 * vThick) {
                bool isOctave = mod(nearestSemi, 12.0) == 0.0;
                float d = isOctave ? strongDelta : lineDelta;
                color = mix(color + d, color - d, step(1.0 - d, color));
            }
        }
    } else if (showVerticalGrid && gridHeightUv > 0.0) {
        // Anchor grid lines to absolute semitones (C0-based) so octave strong
        // lines actually land on C boundaries regardless of minFreq. Mirrors
        // the scale-grid approach: round to nearest integer semi, then draw
        // when that semi is on the grid.
        float bandsPerSemi = sourceBandsPerOctave / 12.0;
        float semisAboveMin = zoomedUv.y * sourceBandCount / bandsPerSemi;
        float absSemis = pitchOffsetSemisFromC0 + semisAboveMin;
        float gridSizeSemis = 12.0 * gridHeightUv * sourceBandCount / sourceBandsPerOctave;

        float nearestSemi = floor(absSemis + 0.5);
        float semiMod = mod(nearestSemi, gridSizeSemis);
        bool onGrid = semiMod < 0.5 || semiMod > gridSizeSemis - 0.5;
        if (onGrid) {
            float targetSemisAboveMin = nearestSemi - pitchOffsetSemisFromC0;
            float targetBandIndex = targetSemisAboveMin * bandsPerSemi;
            float targetUvY = targetBandIndex / sourceBandCount;
            if (abs(zoomedUv.y - targetUvY) < 0.5 * vThick) {
                bool isOctave = mod(nearestSemi, 12.0) == 0.0;
                float d = isOctave ? strongDelta : lineDelta;
                color = mix(color + d, color - d, step(1.0 - d, color));
            }
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