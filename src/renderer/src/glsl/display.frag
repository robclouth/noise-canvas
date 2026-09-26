#include "effect-common.glsl";
#include "display-mags.glsl";

// Uniforms specific to this display material
uniform float minDb;
uniform float maxDb;
uniform float bpm;
uniform float gridSize;

// The colour a layer takes. Left and right sit a hue apart either side of the
// layer's own hue, so a centred signal reads as that hue and the layers of a
// stack add towards white where they overlap. One layer alone is hsv(30) and
// hsv(210) — the orange and blue the picture has always used.
uniform vec3 leftTint;
uniform vec3 rightTint;

// False on a layer drawn behind another, which shows only its spectrogram: the
// grid, the brush preview and the rectangles belong to the layer on top.
uniform bool drawOverlays;

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

// The brush preview, valid in each band only for the bins [start, end) that
// previewBinRangesTex holds for it in .rg; every other bin is read from the
// committed spectrogram. With previewActive off the committed spectrogram
// shows alone.
uniform sampler2D previewTex;
uniform sampler2D previewBinRangesTex;
uniform bool previewActive;

// The coarse canvas: the file at the resolution the screen shows it, over the
// whole file. A dab the canvas cannot show whole is previewed on it, in the
// bins coarsePreviewBinRangesTex holds; a stroke on a windowed file is painted
// on it as well, in the bins coarseStrokeBinRangesTex holds, and shows outside
// the canvas until its full-resolution paint lands.
uniform sampler2D coarseMetaTex;
uniform sampler2D coarseCommittedTex;
uniform sampler2D coarsePreviewTex;
uniform sampler2D coarsePreviewBinRangesTex;
uniform bool coarsePreviewActive;
uniform sampler2D coarseStrokeBinRangesTex;
uniform bool coarseStrokeActive;

// The canvas holds the committed state over a block-aligned frame span of the
// file, laid out by its own metadata; these place that span on the file's
// timeline. The preview's bin ranges are in the same view-local bins.
uniform sampler2D canvasMetadataTex;
uniform float canvasFrameCount;
uniform float canvasStartFrame;

// File time UV as the canvas view's own UV; x leaves [0, 1] outside the span.
// The whole-file view short-circuits so its UV stays bit-exact.
vec2 canvasViewUv(vec2 uv) {
    if (canvasStartFrame == 0.0 && canvasFrameCount == sourceFrameCount) return uv;
    return vec2((uv.x * sourceFrameCount - canvasStartFrame) / canvasFrameCount, uv.y);
}

// The committed picture as two levels of the display pyramid, in dB, with the
// weight of the coarser one. Each level carries its own band layout, so a bin
// index means something different in each. With displayPyramidActive off the
// canvas is read instead.
uniform sampler2D displayFineTex;
uniform sampler2D displayFineMetaTex;
uniform sampler2D displayCoarseTex;
uniform sampler2D displayCoarseMetaTex;
uniform float displayLevelBlend;
uniform bool displayPyramidActive;
// True when the canvas is finer than the pyramid and holds every block of its
// view, so a texel inside the view reads the canvas before the pyramid.
uniform bool displayCanvasFirst;
// True when the screen asks for a finer picture than the pyramid holds, so a
// texel the pyramid ends up serving is still loading.
uniform bool displayFinerWanted;
// True while the pyramid serves a coarser level than the view asked for.
uniform bool displayLoadingAll;
// How far the loading regions are greyed, 0 to 1.
uniform float displayLoading;

// The tile ring: the committed picture around the view, in dB, at a level fine
// enough for the screen. Tile `t` lives in slot `t mod displayTileSlots`, and
// only the tiles [displayTileFirst, displayTileFirst + displayTileCount) are
// there. Every band's tile layout is one metadata texel, the same for every
// slot. With displayTileCount at zero the pyramid is read instead.
uniform sampler2D displayTileTex;
uniform sampler2D displayTileMetaTex;
uniform float displayTileFirst;
uniform float displayTileCount;
uniform float displayTileSlots;
uniform float displayTileTexels;
uniform float displayTileBlend;
uniform float displayTileLevel;

vec4 fetchDisplayTexel(int bandIndex, float bandStartOffset, float timeIndex, ivec2 texSize) {
    ivec2 texel = packedTexel(bandStartOffset + timeIndex, texSize);
    if (previewActive) {
        vec2 bins = texelFetch(previewBinRangesTex, ivec2(bandIndex, 0), 0).rg;
        if (timeIndex >= bins.x && timeIndex < bins.y) return texelFetch(previewTex, texel, 0);
    }
    return texelFetch(sourceSpectrogramTex, texel, 0);
}

vec4 sampleDisplayInterp(vec2 uv) {
    vec2 viewUv = canvasViewUv(uv);
    if (viewUv.x < 0.0 || viewUv.x > 1.0) return vec4(0.0);
    float bandIndex, bandStartOffset, timeIndex0, timeIndex1, timeFraction;
    packedInterpBins(viewUv, canvasMetadataTex, canvasFrameCount, sourceBandCount,
                     bandIndex, bandStartOffset, timeIndex0, timeIndex1, timeFraction);
    ivec2 texSize = textureSize(sourceSpectrogramTex, 0);
    int band = int(bandIndex);
    vec4 sample1 = fetchDisplayTexel(band, bandStartOffset, timeIndex0, texSize);
    vec4 sample2 = fetchDisplayTexel(band, bandStartOffset, timeIndex1, texSize);
    return vec4(interpolateComplex(sample1.rg, sample2.rg, timeFraction),
                interpolateComplex(sample1.ba, sample2.ba, timeFraction));
}

// The dB pair one pyramid level holds, blended along time in its own bins.
// False where either tap is a bin the level has not been drawn into yet.
bool sampleLevelDb(vec2 uv, sampler2D levelTex, sampler2D levelMetaTex, out vec2 db) {
    float bandIndex, bandStartOffset, timeIndex0, timeIndex1, timeFraction;
    packedInterpBins(uv, levelMetaTex, sourceFrameCount, sourceBandCount,
                     bandIndex, bandStartOffset, timeIndex0, timeIndex1, timeFraction);
    ivec2 texSize = textureSize(levelTex, 0);
    vec2 sample1 = texelFetch(levelTex, packedTexel(bandStartOffset + timeIndex0, texSize), 0).rg;
    vec2 sample2 = texelFetch(levelTex, packedTexel(bandStartOffset + timeIndex1, texSize), 0).rg;
    if (!displayDbKnown(sample1) || !displayDbKnown(sample2)) return false;
    db = mix(sample1, sample2, timeFraction);
    return true;
}

// True when the canvas view spans this unpacked UV.
bool canvasSpans(vec2 uv) {
    vec2 viewUv = canvasViewUv(uv);
    return viewUv.x >= 0.0 && viewUv.x <= 1.0;
}

// The dB pair a packed picture holds at `viewUv` of its own span, where
// `binRanges` says `painted` covers either tap's bin: each tap is read from
// `painted` where it is covered and from `under` otherwise. False where
// neither tap is covered.
bool paintedDbAt(vec2 viewUv, sampler2D metaTex, float frameCount, sampler2D painted, sampler2D under,
                 sampler2D binRanges, out vec2 db) {
    if (viewUv.x < 0.0 || viewUv.x > 1.0) return false;
    float bandIndex, bandStartOffset, timeIndex0, timeIndex1, timeFraction;
    packedInterpBins(viewUv, metaTex, frameCount, sourceBandCount,
                     bandIndex, bandStartOffset, timeIndex0, timeIndex1, timeFraction);
    vec2 bins = texelFetch(binRanges, ivec2(int(bandIndex), 0), 0).rg;
    bool covers0 = timeIndex0 >= bins.x && timeIndex0 < bins.y;
    bool covers1 = timeIndex1 >= bins.x && timeIndex1 < bins.y;
    if (!covers0 && !covers1) return false;
    ivec2 texSize = textureSize(painted, 0);
    ivec2 texel0 = packedTexel(bandStartOffset + timeIndex0, texSize);
    ivec2 texel1 = packedTexel(bandStartOffset + timeIndex1, texSize);
    vec4 sample1 = covers0 ? texelFetch(painted, texel0, 0) : texelFetch(under, texel0, 0);
    vec4 sample2 = covers1 ? texelFetch(painted, texel1, 0) : texelFetch(under, texel1, 0);
    vec2 left = interpolateComplex(sample1.rg, sample2.rg, timeFraction);
    vec2 right = interpolateComplex(sample1.ba, sample2.ba, timeFraction);
    db = vec2(displayMagToDb(left.x), displayMagToDb(right.x));
    return true;
}

// Paint not yet in the committed picture: the canvas's preview, else a dab
// previewed on the coarse canvas, else outside the canvas a stroke painted on
// the coarse canvas. False where none of them covers this UV.
bool overlayDbAt(vec2 uv, out vec2 db) {
    if (previewActive && paintedDbAt(canvasViewUv(uv), canvasMetadataTex, canvasFrameCount, previewTex,
                                     sourceSpectrogramTex, previewBinRangesTex, db)) return true;
    if (coarsePreviewActive && paintedDbAt(uv, coarseMetaTex, sourceFrameCount, coarsePreviewTex,
                                           coarseCommittedTex, coarsePreviewBinRangesTex, db)) return true;
    return coarseStrokeActive && !canvasSpans(uv) &&
           paintedDbAt(uv, coarseMetaTex, sourceFrameCount, coarseCommittedTex, coarseCommittedTex,
                       coarseStrokeBinRangesTex, db);
}

// One bin of a band in the tile ring, when the tile holding it is resident.
bool ringBinDb(vec4 meta, float bin, out vec2 db) {
    float binsPerTile = meta.a;
    float tileIndex = floor(bin / binsPerTile);
    if (tileIndex < displayTileFirst || tileIndex >= displayTileFirst + displayTileCount) return false;
    float slot = mod(tileIndex, displayTileSlots);
    float linear = slot * displayTileTexels + meta.r + (bin - tileIndex * binsPerTile);
    db = texelFetch(displayTileTex, packedTexel(linear, textureSize(displayTileTex, 0)), 0).rg;
    return displayDbKnown(db);
}

// The ring's dB pair at an unpacked UV, blended along time and towards the
// next coarser level, when every tile it reads is resident.
bool sampleRingDb(vec2 uv, out vec2 db) {
    if (displayTileCount <= 0.0) return false;
    vec4 meta = fetchBandMetadata(displayTileMetaTex, floor((1.0 - uv.y) * sourceBandCount));
    float scaledTime = uv.x * sourceFrameCount / exp2(meta.b);
    float bin0, bin1, fraction;
    bandTimeIndices(scaledTime, meta.g, bin0, bin1, fraction);

    vec2 fine0, fine1;
    if (!ringBinDb(meta, bin0, fine0) || !ringBinDb(meta, bin1, fine1)) return false;
    db = mix(fine0, fine1, fraction);

    // A band already coarser than the ring's level holds the same bins one
    // level up, so only the finer bands need the coarse tap.
    if (displayTileBlend <= 0.0 || meta.b > displayTileLevel) return true;
    float coarse0, coarse1, coarseFraction;
    bandTimeIndices(scaledTime * 0.5, ceil(meta.g * 0.5), coarse0, coarse1, coarseFraction);
    // One level up keeps every second bin, so it reads the same tiles at even
    // indices. Where that crosses out of the ring the fine read stands alone.
    vec2 up0, up1;
    if (!ringBinDb(meta, min(coarse0 * 2.0, meta.g - 1.0), up0)) return true;
    if (!ringBinDb(meta, min(coarse1 * 2.0, meta.g - 1.0), up1)) return true;
    db = mix(db, mix(up0, up1, coarseFraction), displayTileBlend);
    return true;
}

// The pyramid's dB pair at an unpacked UV, blended between the two levels
// whose bins bracket the screen.
bool samplePyramidDb(vec2 uv, out vec2 db) {
    if (!displayPyramidActive) return false;
    // The blend is uniform across the view, so the coarse read is skipped
    // outright wherever the fine level alone is what the view asked for.
    if (!sampleLevelDb(uv, displayFineTex, displayFineMetaTex, db)) return false;
    if (displayLevelBlend > 0.0) {
        vec2 coarse;
        if (!sampleLevelDb(uv, displayCoarseTex, displayCoarseMetaTex, coarse)) return false;
        db = mix(db, coarse, displayLevelBlend);
    }
    return true;
}

// Left and right magnitudes of the picture at an unpacked UV: a resident
// tile, else the canvas where it is the finest picture there, else the
// pyramid, else the canvas. `loading` is 1 where the pyramid stands in for
// a finer picture that has not landed, and `unknown` is 1 where nothing holds
// the picture yet — an undrawn store must not read as a loud one.
vec2 sampleDisplayMags(vec2 uv, out float loading, out float unknown) {
    loading = displayLoadingAll ? 1.0 : 0.0;
    unknown = 0.0;
    vec2 db;
    if (overlayDbAt(uv, db)) {
        loading = 0.0;
        return vec2(displayDbToMag(db.x), displayDbToMag(db.y));
    }
    bool have = sampleRingDb(uv, db);
    if (!have && displayCanvasFirst && canvasSpans(uv)) {
        loading = 0.0;
        vec4 packedValue = sampleDisplayInterp(uv);
        return vec2(packedValue.r, packedValue.b);
    }
    if (!have) {
        if (!samplePyramidDb(uv, db)) {
            loading = 0.0;
            if (canvasSpans(uv)) {
                vec4 packedValue = sampleDisplayInterp(uv);
                return vec2(packedValue.r, packedValue.b);
            }
            unknown = 1.0;
            return vec2(0.0);
        }
        if (displayFinerWanted) loading = 1.0;
    }
    return vec2(displayDbToMag(db.x), displayDbToMag(db.y));
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
    float loading0, loading1, unknown0, unknown1;
    vec2 mags = mix(sampleDisplayMags(uv0, loading0, unknown0), sampleDisplayMags(uv1, loading1, unknown1), bandFrac);
    float loading = mix(loading0, loading1, bandFrac) * displayLoading;
    float unknown = mix(unknown0, unknown1, bandFrac);

    float leftDb = magnitudeToDb(mags.x);

    vec3 color;
    if (sourceChannelCount == 1) {
        // One channel takes both sides of the layer's hue pair, which sums to
        // the layer's own hue — white for the pair a lone layer uses.
        color = leftDb * (leftTint + rightTint);
    } else {
        float rightDb = magnitudeToDb(mags.y);
        color = leftTint * leftDb + rightTint * rightDb;
    }

    // Everything from here is chrome over the picture: the hatch, the loading
    // tint, the grid and the brush rectangles. A layer drawn behind another
    // contributes only its spectrogram, or a stack would carry one grid per
    // layer.
    if (drawOverlays) {

    // Where nothing holds the picture yet the ground is a dark hatch, so an
    // undrawn region reads as "not known" rather than as a loud one. It needs
    // no grace: there is no picture to flash away from.
    if (unknown > 0.0) {
        float hatch = 0.5 + 0.5 * sin((gl_FragCoord.x + gl_FragCoord.y) * 0.35);
        color = mix(color, vec3(0.10 + 0.08 * hatch), unknown);
    }

    // A region still loading is flattened to a mid grey with faint diagonal
    // stripes, the picture showing through it dimly.
    if (loading > 0.0) {
        float luma = dot(color, vec3(0.299, 0.587, 0.114));
        float stripe = 0.5 + 0.5 * sin((gl_FragCoord.x + gl_FragCoord.y) * 0.45);
        vec3 greyed = vec3(0.2 + 0.3 * luma + 0.04 * stripe);
        color = mix(color, greyed, loading * 0.85);
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

    }

    outColor = vec4(color, 1.0);
}