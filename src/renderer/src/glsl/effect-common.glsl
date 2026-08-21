// ============================================================================
// UNIFORMS & STRUCTS
// ============================================================================

#include "common.glsl"
#include "brush-space.glsl"

uniform sampler2D sourceSpectrogramTex;
uniform sampler2D sourceMetadataTex;
uniform sampler2D sourceInverseMapTex;
uniform vec2      sourceSpectrogramTextureSize; // kept for compatibility (not required by texelFetch)
uniform float     sourceFrameCount;
uniform float     sourceBandCount;
uniform int       sourceChannelCount;
uniform float     sourceMinFreq;
uniform float     sourceBandsPerOctave;
uniform float     sourceSampleRate;
// Nearest-onset lookup for the source file: R = onset time (sec), G = strength
// 0..1, sampled by unpacked source UV.x. See lib/onset-map.ts.
uniform sampler2D sourceOnsetTex;

uniform sampler2D destSpectrogramTex;
uniform sampler2D destMetadataTex;
uniform sampler2D destInverseMapTex;
uniform vec2      destSpectrogramTextureSize;   // kept for compatibility
uniform float     destFrameCount;
uniform float     destBandCount;
uniform int       destChannelCount;
uniform float     destSampleRate;
uniform float     destMinFreq;
uniform float     destBandsPerOctave;

uniform sampler2D originalSpectrogramTex;

uniform float viewZoomPower;
uniform float viewOffset;
uniform float viewZoomPowerY;
uniform float viewOffsetY;
uniform Parameter brushCurveTime;
uniform Parameter brushSkewTime;
uniform Parameter brushCurvePitch;
uniform Parameter brushSkewPitch;
uniform float sourceOffsetX;
uniform float sourceOffsetY;
uniform float sourceTimeScale;
uniform float sourceBandScale;
uniform Parameter sourceTimeOffset;
uniform Parameter sourcePitchOffset;
uniform Parameter brushPan;
uniform Parameter brushIntensity;
uniform int   blendMode;
uniform int   algorithm;
// Safety valve for effects (transmute swap, sort) whose output intentionally
// places non-magnitude values in the magnitude slot. Phase-aware interpolation
// would log-blend negative "magnitudes" and produce NaN for those cases.
uniform bool  useLinearBlend;
// Applies the effect at full weight everywhere the brush reaches. An effect
// that maps the pair into another domain (transmute swap) is only reversible
// when both passes cover the footprint whole, and a partial envelope weight
// leaves a blend of the two domains behind.
uniform bool  bypassBrushWeight;
// True when the pass before this one handed over a pair that no longer holds a
// magnitude and a phase. Only the effect that made the swap reads it, to know
// whether it is opening the swap or closing it again.
uniform bool  inSwappedDomain;

// New uniform to prevent runaway feedback. Set to > 0 to enable.
// A value of 1.0 is a good starting point.
uniform float magnitudeLimit;

uniform sampler2D strokeMaskTex;
uniform bool useStrokeMask;
uniform sampler2D blendOriginalTex;

// ============================================================================
// DEFINES & HELPERS
// ============================================================================

// Unwraps a phase angle to the range [-PI, PI].
float unwrapPhase(float phaseDelta) {
  return mod(phaseDelta + PI, 2.0 * PI) - PI;
}

vec2 unwrapPhase(vec2 phaseDelta) {
  return mod(phaseDelta + PI, 2.0 * PI) - PI;
}

// --- Complex Number & Polar Helpers ---
// NOTE: The texture data is stored as [magnitude, unwrappedPhase] not [real, imaginary]
float getMag(vec2 magPhase)   { return magPhase.x; }
float getPhase(vec2 magPhase) { return magPhase.y; }
vec2  fromPolar(float mag, float phase) { return vec2(mag, phase); }
vec2  toComplex(vec2 magPhase) { return magPhase.x * vec2(cos(magPhase.y), sin(magPhase.y)); }
vec2  polarFromComplex(vec2 z) { return vec2(length(z), atan(z.y, z.x)); }

// Hard ceiling that always applies, even when the soft-clip is disabled, so
// repeated boosting or feedback can't drive magnitudes to inf/NaN. It sits far
// above any musical level (the audio limiter governs actual output level), so it
// never colours normal use.
const float MAGNITUDE_HARD_CEILING = 1.0e15;

/**
 * Clamps magnitude to a hard ceiling, and optionally applies a soft-clipping
 * saturation curve above magnitudeLimit when that is enabled (> 0).
 */
vec2 limitMagnitude(vec2 magPhase) {
  float mag = getMag(magPhase);
  if (mag > MAGNITUDE_HARD_CEILING) return vec2(MAGNITUDE_HARD_CEILING, magPhase.y);

  if (magnitudeLimit <= 0.0) return magPhase;
  if (mag <= magnitudeLimit) return magPhase;

  float excessMag       = mag - magnitudeLimit;
  float saturatedExcess = magnitudeLimit * tanh(excessMag / magnitudeLimit);
  float newMag          = magnitudeLimit + saturatedExcess;
  return vec2(newMag, magPhase.y);
}

// ============================================================================
// COORDINATE UTILITIES
// ============================================================================

struct ProcessingUvs {
  vec2 dest;     // Unpacked UV we are writing TO
  vec2 source;   // Unpacked UV we are sampling FROM (= sourceL, kept for code that is OK being mono)
  vec2 sourceL;  // Per-channel source UV for L (stereo-aware callsites sample .rg here)
  vec2 sourceR;  // Per-channel source UV for R (stereo-aware callsites sample .ba here)
  bool sameSourceUv; // True when sourceL == sourceR — effects must branch on this to keep the
                     // spread=0 fast path (single texture read) instead of double-sampling.
};

// Converts a packed texture UV to an unpacked spectrogram UV.
// (Continuous read -> keep filtered sampling)
vec2 packedToUnpackedUv(sampler2D inverseMapTex, vec2 packedUv, float frameCount, float bandCount) {
  vec2 unpackedPixelCoords = texture(inverseMapTex, packedUv).rg;
  float u = unpackedPixelCoords.x / max(1.0, frameCount);
  float v = 1.0 - (unpackedPixelCoords.y + 0.5) / max(1.0, bandCount);
  return vec2(u, v);
}

// getProcessingUvs is defined after modulation-common.glsl include (needs applyModulation)

// ============================================================================
// SPECTROGRAM SAMPLING (texelFetch where exact texels are addressed)
// ============================================================================

// Fetch a metadata texel for a given band index from a 1×N or N×1 metadata texture.
vec4 fetchBandMetadata(sampler2D metaTex, float bandIndexFloat) {
  int bandIndex = int(clamp(floor(bandIndexFloat), 0.0, 1e9));
  ivec2 metaSize = textureSize(metaTex, 0);     // (width, height)
  // Most meta textures here are (numBands, 1). Clamp to bounds either way.
  int x = clamp(bandIndex, 0, max(metaSize.x - 1, 0));
  int y = 0;
  return texelFetch(metaTex, ivec2(x, y), 0);
}

/**
 * Read a single complex value pair (stereo) from a packed spectrogram at an unpacked UV.
 * Point-sampled, no interpolation. Uses texelFetch for exact reads.
 */
vec4 readPackedData(vec2 unpackedUv,
                    sampler2D dataTex,
                    sampler2D metaTex,
                    float frameCount,
                    float bandCount) {
  float bandIndex = floor((1.0 - unpackedUv.y) * bandCount);
  vec4 meta = fetchBandMetadata(metaTex, bandIndex);
  float bandStartOffset   = meta.r;
  float bandLength        = meta.g;
  float bandTimeScaleExp  = meta.b;

  float timeInFrames      = unpackedUv.x * frameCount;
  float scaledTime        = timeInFrames / exp2(bandTimeScaleExp);
  float timeIndexInBand   = floor(scaledTime);
  timeIndexInBand         = clamp(timeIndexInBand, 0.0, bandLength - 1.0);

  // Map linear pixel index -> integer texel coords
  ivec2 texSize = textureSize(dataTex, 0);
  float safeWidthF = float(max(texSize.x, 1));
  float linearPixelIndex = bandStartOffset + timeIndexInBand;

  int px = int(mod(linearPixelIndex, safeWidthF));
  int py = int(floor(linearPixelIndex / safeWidthF));
  px = clamp(px, 0, max(texSize.x - 1, 0));
  py = clamp(py, 0, max(texSize.y - 1, 0));

  return texelFetch(dataTex, ivec2(px, py), 0);
}

// Public sampling helpers
vec4 sampleSourceNoInterp(vec2 sourceUv) {
  vec2 wrappedUv = wrapUv(sourceUv);
  return readPackedData(wrappedUv, sourceSpectrogramTex, sourceMetadataTex, sourceFrameCount, sourceBandCount);
}

vec4 getSourceMetadata(vec2 uv) {
  float rawIndex = (1.0 - uv.y) * sourceBandCount;
  return fetchBandMetadata(sourceMetadataTex, rawIndex);
}

vec4 getDestMetadata(vec2 uv) {
  float rawIndex = (1.0 - uv.y) * destBandCount;
  return fetchBandMetadata(destMetadataTex, rawIndex);
}

vec4 readSourceAtTimeIndex(float timeIndex, float bandStartOffset) {
  ivec2 texSize = textureSize(sourceSpectrogramTex, 0);
  float safeWidthF = float(max(texSize.x, 1));
  float linearPixelIndex = bandStartOffset + timeIndex;

  int px = int(mod(linearPixelIndex, safeWidthF));
  int py = int(floor(linearPixelIndex / safeWidthF));
  px = clamp(px, 0, max(texSize.x - 1, 0));
  py = clamp(py, 0, max(texSize.y - 1, 0));

  return texelFetch(sourceSpectrogramTex, ivec2(px, py), 0);
}

// Interpolate between two magnitude/phase pairs. Magnitudes blend in log space
// and phases take the shortest arc around the unwrapped representation so
// values near ±PI don't collapse through zero.
vec2 interpolateComplex(vec2 magPhase1, vec2 magPhase2, float amount) {
  float magMix   = exp(mix(log(magPhase1.x + 1e-9), log(magPhase2.x + 1e-9), amount));
  float phaseMix = magPhase1.y + amount * unwrapPhase(magPhase2.y - magPhase1.y);
  return vec2(magMix, phaseMix);
}

// The two time indices a linear read straddles inside one band, plus the
// fraction between them. On a wrapping time axis the last frame's partner is
// the band's first frame, so a loop has no seam; otherwise both indices stay
// clamped inside the band, since index bandLength is the START of the next
// (lower-frequency) band in the packed layout, not a later time.
void bandTimeIndices(float scaledTime, float bandLength, out float index0, out float index1, out float fraction) {
  float frames = max(bandLength, 1.0);
  float t = wrapsTimeAxis() ? mod(scaledTime, frames) : clamp(scaledTime, 0.0, frames - 1.0);
  index0 = floor(t);
  fraction = t - index0;
  index1 = wrapsTimeAxis() ? mod(index0 + 1.0, frames) : min(index0 + 1.0, frames - 1.0);
}

/**
 * Interpolated read between two time samples (uses texelFetch for the exact texels).
 */
vec4 readPackedDataInterpolated(vec2 unpackedUv,
                                sampler2D dataTex,
                                sampler2D metaTex,
                                float frameCount,
                                float bandCount) {
  float bandIndex = floor((1.0 - unpackedUv.y) * bandCount);

  vec4 meta = fetchBandMetadata(metaTex, bandIndex);
  float bandStartOffset  = meta.r;
  float bandLength       = meta.g;
  float bandTimeScaleExp = meta.b;

  float timeInFrames = unpackedUv.x * frameCount;
  float scaledTime = timeInFrames / exp2(bandTimeScaleExp);

  float timeIndex0, timeIndex1, timeFraction;
  bandTimeIndices(scaledTime, bandLength, timeIndex0, timeIndex1, timeFraction);

  ivec2 texSize    = textureSize(dataTex, 0);
  float widthFloat = float(max(texSize.x, 1));

  float linearIndex1 = bandStartOffset + timeIndex0;
  int px1 = int(mod(linearIndex1, widthFloat));
  int py1 = int(floor(linearIndex1 / widthFloat));
  px1 = clamp(px1, 0, max(texSize.x - 1, 0));
  py1 = clamp(py1, 0, max(texSize.y - 1, 0));
  vec4 sample1 = texelFetch(dataTex, ivec2(px1, py1), 0);

  float linearIndex2 = bandStartOffset + timeIndex1;
  int px2 = int(mod(linearIndex2, widthFloat));
  int py2 = int(floor(linearIndex2 / widthFloat));
  px2 = clamp(px2, 0, max(texSize.x - 1, 0));
  py2 = clamp(py2, 0, max(texSize.y - 1, 0));
  vec4 sample2 = texelFetch(dataTex, ivec2(px2, py2), 0);

  vec2 magPhaseL = interpolateComplex(sample1.rg, sample2.rg, timeFraction);
  vec2 magPhaseR = interpolateComplex(sample1.ba, sample2.ba, timeFraction);
  return vec4(magPhaseL, magPhaseR);
}

vec4 sampleSourceInterp(vec2 sourceUv) {
  return readPackedDataInterpolated(sourceUv, sourceSpectrogramTex, sourceMetadataTex, sourceFrameCount, sourceBandCount);
}

/**
 * Calculate audio level in dB from the spectrogram at a given position.
 */
float getAudioLevelDb(vec2 uv) {
  vec4 sourceTexel = sampleSourceInterp(uv);
  float magnitudeL = getMag(sourceTexel.rg);
  float magnitudeR = getMag(sourceTexel.ba);
  float avgMagnitude = max(0.5 * (magnitudeL + magnitudeR), 1e-6);
  return 20.0 * log(avgMagnitude) / log(10.0);
}

// Sampling functions are now available; include modulation helpers so the
// envelope follower can directly sample phase/panning from the spectrogram.
#define HAS_SPECTROGRAM_SAMPLING
#include "modulation-common.glsl"

// Forward freq-preserving map: dest UV.y → source UV.y such that the two UVs
// refer to the same absolute frequency. Works across different minFreq /
// bandsPerOctave / bandCount, and is the exact inverse of sourceToDestBandUv.
// Gaborator's band layout has UV.y increasing with frequency (band 0 = top of
// UV = highest freq), so both bandIdx values below count up from the lowest
// band as UV.y rises. Each freq anchor is that texture's actual lowest-band
// center freq read from metadata, since gaborator snaps the requested minFreq
// to its internal band tuning and the two can disagree by up to half a band —
// using the config value would let (sourceBandIdx + 0.5) round to the next
// integer and shift every bin.
// The layout is geometric, so the dest frequency is computed in closed form
// rather than fetched by band index: that fetch saturates at the outermost
// band, which would pin a UV that a pitch shift pushed past the top or bottom
// to the edge band. Everything downstream — the canvas wrap below, and the
// brush edge modes, which invert this map — would then never see that the read
// had left the canvas at all.
float destToSourceBandUv(vec2 destUnpackedUv) {
  float destLowestFreq = max(fetchBandMetadata(destMetadataTex, destBandCount - 1.0).a, 1e-6);
  float sourceLowestFreq = max(fetchBandMetadata(sourceMetadataTex, sourceBandCount - 1.0).a, 1e-6);
  float destBandIdx = wrapUv(destUnpackedUv).y * destBandCount - 0.5;
  float destFreqHz = destLowestFreq * exp2(destBandIdx / max(destBandsPerOctave, 1e-6));
  float sourceBandIdx = sourceBandsPerOctave * log2(max(destFreqHz, 1e-6) / sourceLowestFreq);
  return (sourceBandIdx + 0.5) / max(sourceBandCount, 1.0);
}

// Inverse of destToSourceBandUv: source UV.y → dest UV.y for the same freq.
// Needed by brush-bounds checks that receive a source UV and want to compare
// against dest-space brush bounds. Uses each texture's actual lowest-band freq
// as the anchor (see destToSourceBandUv).
float sourceToDestBandUv(float sourceBandUvY) {
  float sourceLowestFreq = max(fetchBandMetadata(sourceMetadataTex, sourceBandCount - 1.0).a, 1e-6);
  float destLowestFreq = max(fetchBandMetadata(destMetadataTex, destBandCount - 1.0).a, 1e-6);
  float sourceBandIdx = sourceBandUvY * sourceBandCount - 0.5;
  float sourceFreqHz = sourceLowestFreq * exp2(sourceBandIdx / max(sourceBandsPerOctave, 1e-6));
  float destBandIdx = destBandsPerOctave * log2(max(sourceFreqHz, 1e-6) / destLowestFreq);
  return (destBandIdx + 0.5) / max(destBandCount, 1.0);
}

// Map a source-space UV back to the dest-space UV that would produce it. Used
// by brush containment helpers so the geometry of the brush stays defined in
// dest UV and we don't have to approximate a nonlinear freq map as a scalar.
vec2 sourceUvToDestUv(vec2 sourceUv) {
  float destX = (sourceUv.x - sourceOffsetX) / max(sourceTimeScale, 1e-6);
  float destY = sourceToDestBandUv(sourceUv.y - sourceOffsetY);
  return vec2(destX, destY);
}

// Forward freq-preserving map from a dest UV (inside brush) to the source UV
// that samples the same frequency at the same beat-time.
vec2 destUvToSourceUv(vec2 destUv) {
  float sourceX = destUv.x * sourceTimeScale + sourceOffsetX;
  float sourceY = destToSourceBandUv(destUv) + sourceOffsetY;
  return vec2(sourceX, sourceY);
}

ProcessingUvs getProcessingUvs(vec2 destPackedUv) {
  ProcessingUvs uvs;
  uvs.dest = packedToUnpackedUv(destInverseMapTex, destPackedUv, destFrameCount, destBandCount);

  // Stereo-aware source UV offsets. When every modulator driving these params has
  // stereoSpread == 0, the two components of each vec2 are equal and sameSourceUv
  // falls out true — effects then take the single-sample fast path.
  vec2 srcMods[NUM_MODULATORS];
  sampleModulators(srcMods);
  vec2 modTimeOff = applyModulationCached(
    sourceTimeOffset.value, sourceTimeOffset.minValue, sourceTimeOffset.maxValue,
    sourceTimeOffset.modulationAmounts, sourceTimeOffset.contextualModAmounts, sourceTimeOffset.macroAmounts,
    srcMods
  );
  vec2 modPitchOff = applyModulationCached(
    sourcePitchOffset.value, sourcePitchOffset.minValue, sourcePitchOffset.maxValue,
    sourcePitchOffset.modulationAmounts, sourcePitchOffset.contextualModAmounts, sourcePitchOffset.macroAmounts,
    srcMods
  );

  float baseX = uvs.dest.x * sourceTimeScale + sourceOffsetX;
  float baseY = destToSourceBandUv(uvs.dest) + sourceOffsetY;
  vec2 baseUv = vec2(baseX, baseY);
  uvs.sourceL = baseUv + vec2(modTimeOff.x, modPitchOff.x);
  uvs.sourceR = baseUv + vec2(modTimeOff.y, modPitchOff.y);
  uvs.source  = uvs.sourceL;
  uvs.sameSourceUv = (modTimeOff.x == modTimeOff.y) && (modPitchOff.x == modPitchOff.y);
  return uvs;
}

/**
 * Samples from the original, unmodified destination spectrogram with interpolation.
 */
vec4 getOriginalDestSample(vec2 destUv) {
  vec2 wrappedUv = wrapUv(destUv);
  return readPackedDataInterpolated(wrappedUv, originalSpectrogramTex, destMetadataTex, destFrameCount, destBandCount);
}

// ============================================================================
// PHASE MOVE PRIMITIVES
//
// Stored phase is unwrapped and measured against the band's centre-frequency
// carrier, so any rule that moves content across the time-frequency grid is a
// sum of products 2π·(fA − fB)·(tA − tB) built from the two primitives below.
// Time reversal and pitch flip conjugate stored phase (φ → parity·φ with
// parity = signX·signY); the conjugation belongs to every stored-phase term a
// rule transports — deviations included — and never to carrier terms.
// ============================================================================

// Re-expresses a phase stored against one band carrier as stored against
// another, at the coefficient time the phase describes.
float carrierRebase(float fcFromHz, float fcToHz, float tSec) {
  return TWO_PI * (fcFromHz - fcToHz) * tSec;
}

// Phase advance of content oscillating at fHz against a carrier at fcHz over
// dtSec. fHz picks the content model: a measured frequency for a sustained
// partial, a target frequency for a retune, 0 for a waveform moved with its
// absolute phase frozen (the transient rule).
float contentAdvance(float fHz, float fcHz, float dtSec) {
  return TWO_PI * (fHz - fcHz) * dtSec;
}

// How far a measured instantaneous frequency may sit from its band centre, as
// a fraction of the centre, before the estimate reads as numerical junk.
const float FREQ_DEV_CLAMP = 0.06;

// Instantaneous-frequency deviation from the band carrier, in Hz, from three
// consecutive stored phases on the band's own time grid.
float instFreqDevHz(float pPrev, float pCenter, float pNext, float dtSec) {
  return (unwrapPhase(pCenter - pPrev) + unwrapPhase(pNext - pCenter)) * 0.5 / (TWO_PI * dtSec);
}

vec2 modifyPhase(vec2 magPhase, vec2 uv, bool shouldRandomise) {
  float mag = getMag(magPhase);
  float phase = getPhase(magPhase);
  if (shouldRandomise) {
    vec2 seed1 = uv;
    vec2 seed2 = uv + vec2(12.34, 56.78);
    phase = random(seed1 + random(seed2)) * TWO_PI;
    return fromPolar(mag, phase);
  }
  return magPhase;
}

vec4 getTransformedSampleBasic(vec2 sourceUv, bool shouldRandomisePhase, float scaleX, vec2 destUv) {
  float bandIndex = floor((1.0 - sourceUv.y) * sourceBandCount);
  vec4 meta = fetchBandMetadata(sourceMetadataTex, bandIndex);
  float bandStartOffset  = meta.r;
  float bandLength       = meta.g;
  float bandTimeScaleExp = meta.b;

  float timeInFrames   = sourceUv.x * sourceFrameCount;
  float scaledTime     = timeInFrames / exp2(bandTimeScaleExp);

  float timeIndex0, timeIndex1, timeFraction;
  bandTimeIndices(scaledTime, bandLength, timeIndex0, timeIndex1, timeFraction);

  ivec2 sSize    = textureSize(sourceSpectrogramTex, 0);
  float widthF   = float(max(sSize.x, 1));

  float linearIndex1 = bandStartOffset + timeIndex0;
  int px1 = int(mod(linearIndex1, widthF));
  int py1 = int(floor(linearIndex1 / widthF));
  px1 = clamp(px1, 0, max(sSize.x - 1, 0));
  py1 = clamp(py1, 0, max(sSize.y - 1, 0));
  vec4 sample0 = texelFetch(sourceSpectrogramTex, ivec2(px1, py1), 0);

  float linearIndex2 = bandStartOffset + timeIndex1;
  int px2 = int(mod(linearIndex2, widthF));
  int py2 = int(floor(linearIndex2 / widthF));
  px2 = clamp(px2, 0, max(sSize.x - 1, 0));
  py2 = clamp(py2, 0, max(sSize.y - 1, 0));
  vec4 sample1 = texelFetch(sourceSpectrogramTex, ivec2(px2, py2), 0);

  vec2 correctedL = interpolateComplex(sample0.rg, sample1.rg, timeFraction);
  vec2 correctedR = interpolateComplex(sample0.ba, sample1.ba, timeFraction);

  correctedL = modifyPhase(correctedL, vec2(px1, py1), shouldRandomisePhase);
  correctedR = modifyPhase(correctedR, vec2(px1, py1), shouldRandomisePhase);

  // Time reversal: dest_phase = -src_phase - 2π·f·T
  // Derived from: C_rev(tc, f) = exp(-i·2π·f·T) · conj( C_src(T−tc, f) )
  if (scaleX < 0.0) {
    float destFreqHz = getDestMetadata(destUv).a;
    float phaseShift = contentAdvance(0.0, destFreqHz, (destFrameCount - 1.0) / destSampleRate);
    correctedL.y = -correctedL.y + phaseShift;
    correctedR.y = -correctedR.y + phaseShift;
  }

  return vec4(correctedL, correctedR);
}

vec4 getTransformedSampleSnappy(vec2 sourceUv, bool shouldRandomisePhase, vec2 destUv, float scaleX) {
  vec4 original = sampleSourceNoInterp(destUv);
  float originalPhaseL = getPhase(original.rg);
  float originalPhaseR = getPhase(original.ba);

  float bandIndex = floor((1.0 - sourceUv.y) * sourceBandCount);
  vec4 meta = fetchBandMetadata(sourceMetadataTex, bandIndex);
  float bandStartOffset  = meta.r;
  float bandLength       = meta.g;
  float bandTimeScaleExp = meta.b;

  float timeInFrames   = sourceUv.x * sourceFrameCount;
  float scaledTime     = timeInFrames / exp2(bandTimeScaleExp);
  float timeIndex0, timeIndex1, timeFraction;
  bandTimeIndices(scaledTime, bandLength, timeIndex0, timeIndex1, timeFraction);

  ivec2 sSize    = textureSize(sourceSpectrogramTex, 0);
  float widthF   = float(max(sSize.x, 1));

  float linearIndex1 = bandStartOffset + timeIndex0;
  int px1 = int(mod(linearIndex1, widthF));
  int py1 = int(floor(linearIndex1 / widthF));
  px1 = clamp(px1, 0, max(sSize.x - 1, 0));
  py1 = clamp(py1, 0, max(sSize.y - 1, 0));
  vec4 smp0 = texelFetch(sourceSpectrogramTex, ivec2(px1, py1), 0);

  float linearIndex2 = bandStartOffset + timeIndex1;
  int px2 = int(mod(linearIndex2, widthF));
  int py2 = int(floor(linearIndex2 / widthF));
  px2 = clamp(px2, 0, max(sSize.x - 1, 0));
  py2 = clamp(py2, 0, max(sSize.y - 1, 0));
  vec4 smp1 = texelFetch(sourceSpectrogramTex, ivec2(px2, py2), 0);

  float magL = mix(getMag(smp0.rg), getMag(smp1.rg), timeFraction);
  float magR = mix(getMag(smp0.ba), getMag(smp1.ba), timeFraction);

  float phaseDiffL = getPhase(smp1.rg) - getPhase(smp0.rg);
  float phaseDiffR = getPhase(smp1.ba) - getPhase(smp0.ba);

  vec2 correctedL = fromPolar(magL, originalPhaseL + phaseDiffL);
  vec2 correctedR = fromPolar(magR, originalPhaseR + phaseDiffR);

  // Time reversal: dest_phase = -src_phase - 2π·f·T
  // Derived from: C_rev(tc, f) = exp(-i·2π·f·T) · conj( C_src(T−tc, f) )
  if (scaleX < 0.0) {
    float destFreqHz = getDestMetadata(destUv).a;
    float phaseShift = contentAdvance(0.0, destFreqHz, (destFrameCount - 1.0) / destSampleRate);
    correctedL.y = -correctedL.y + phaseShift;
    correctedR.y = -correctedR.y + phaseShift;
  }

  return vec4(correctedL, correctedR);
}

vec4 getTransformedSampleNeutralish(vec2 sourceUv, vec2 destUv, float scaleX, float scaleY, float shiftX, float shiftY) {
  vec2 sampleUv = sourceUv;
  bool needsWrap = (wrapMode != 0) && (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0);
  if (needsWrap) sampleUv = wrapUv(sampleUv);

  vec4 magPhase = sampleSourceInterp(sampleUv);

  // Apply time scaling to phase
  magPhase.y *= scaleX;
  magPhase.w *= scaleX;

  vec4 sourceMeta = getSourceMetadata(sampleUv);
  vec4 destMeta   = getDestMetadata(destUv);
  float sourceBandFreqHz = sourceMeta.a;
  float destBandFreqHz   = destMeta.a;
  float sourceTimeScaleExp = sourceMeta.b;
  float destTimeScaleExp   = destMeta.b;

  float safeSourceFreqHz = max(sourceBandFreqHz, 1e-6);
  float safeDestFreqHz   = max(destBandFreqHz, 1e-6);

  float scaleXInfluence        = clamp(abs(scaleX - 1.0) * 4.0, 0.0, 1.0);
  float scaleYInfluence        = clamp(abs(scaleY - 1.0) * 4.0, 0.0, 1.0);
  float verticalShiftInfluence = clamp(abs(shiftY) * destBandCount, 0.0, 1.0);
  float reverseInfluence       = scaleX < 0.0 ? 1.0 : 0.0;
  float complexMix             = clamp(max(scaleXInfluence, reverseInfluence) + max(scaleYInfluence, verticalShiftInfluence), 0.0, 1.0);

  float freqRatio = (safeSourceFreqHz > 0.0) ? safeDestFreqHz / safeSourceFreqHz : 1.0;
  magPhase.y *= freqRatio;
  magPhase.w *= freqRatio;

  float framesShift   = shiftX * sourceFrameCount;
  float bandStride    = exp2(sourceTimeScaleExp);
  float linearSeconds = framesShift / sourceSampleRate;
  float strideSeconds = framesShift * bandStride / sourceSampleRate;
  float timeDiffSeconds = mix(linearSeconds, strideSeconds, complexMix);

  float phaseCorrection = TWO_PI * sourceBandFreqHz * timeDiffSeconds * scaleX * freqRatio;

  if (scaleX < 0.0) {
    float totalDuration = (sourceFrameCount - 1.0) / sourceSampleRate;
    phaseCorrection += -TWO_PI * sourceBandFreqHz * totalDuration;
  }

  magPhase.y += phaseCorrection;
  magPhase.w += phaseCorrection;

  if (complexMix > 1e-5) {
    vec4 originalDest = getOriginalDestSample(destUv);
    float destStride = exp2(destTimeScaleExp);
    float originalPhaseWeight = clamp(destStride / (destStride + 1.0), 0.0, 0.95);
    originalPhaseWeight *= complexMix;
    float newPhaseWeight = 1.0 - originalPhaseWeight;
    magPhase.y = newPhaseWeight * magPhase.y + originalPhaseWeight * originalDest.g;
    magPhase.w = newPhaseWeight * magPhase.w + originalPhaseWeight * originalDest.a;
  }

  return magPhase;
}

/**
 * Algorithm 4 — the plain neutral rule
 *
 * Unified phase formula for arbitrary 2D spectrogram transforms.
 * Handles any combination of: time stretch, time reversal, pitch shift,
 * pitch flip, and time/pitch translation.
 *
 * Core formula:  φ_dest = scaleX × signY × φ_src × freqRatio
 *
 * Why this works: for a component at frequency f₀ = f_b + Δf, the source
 * global phase is φ_src = φ₀ + 2π·Δf·t_src. Multiplying by scaleX:
 *
 *   scaleX × φ_src(t_dest/|S|) = scaleX·φ₀ + signX·2π·Δf·t_dest
 *
 * The synthesis adds 2π·f_b·t_dest, giving total frequency f_b + Δf = f₀.
 * The scale handles BOTH sign (reversal) and magnitude (stretch) in one
 * operation — no per-frame IF estimation, no error accumulation, every
 * pixel computed independently.
 *
 * For pitch change, multiplying by freqRatio = f_dst/f_ideal scales all
 * phase advance rates to match the target frequency. f_ideal is the exact
 * frequency the transform asks to read; the residual between it and the
 * centre of the band actually sampled is a carrier change, not a shift, and
 * is re-anchored additively (see neutralPhase).
 *
 * For time shift, a band-frequency carrier correction is added to
 * compensate for the synthesis happening at a different absolute time.
 */
// How far the continuous read position may sit from the sampled band's centre,
// in band units, and still count as ON the centre. Float noise in the
// freq-preserving UV map reaches ~1e-4 bands; a real grid offset — two layouts
// whose centres interleave, or a fractional pitch shift a user would notice —
// is orders of magnitude larger. Inside the dead zone the residual snaps to
// zero so an aligned read keeps phaseGain = 1 and a zero re-anchor exactly.
const float BAND_FRAC_DEADZONE = 1e-3;

// Physical time stretch of a move. Callers pass scaleX in the shared map
// convention (dest→source UV slope = sourceTimeScale / scaleX), and the two
// files' UV axes can cover different durations, so the read slope in seconds
// is (sourceTimeScale / scaleX) · T_src / T_dest; this returns its inverse.
// For a same-file transform it reduces to scaleX exactly; for a paste between
// files of different lengths at equal tempo it reduces to 1, because such a
// paste moves content without stretching it.
float physicalTimeScale(float scaleX) {
  float T_src  = max(sourceFrameCount - 1.0, 1.0) / max(sourceSampleRate, 1e-6);
  float T_dest = max(destFrameCount - 1.0, 1.0) / max(destSampleRate, 1e-6);
  return scaleX * T_dest / (max(sourceTimeScale, 1e-6) * T_src);
}

// The plain phase rule on its own, so algorithm 6 can blend against it without
// a second copy of the maths. Returns (left, right), and reports the multiplier
// it applied to the stored phase — 1 means the stored phase came through
// untouched, anything else means it was rescaled.
vec2 neutralPhase(vec2 sourceUv, vec2 destUv, float scaleX, float scaleY, vec4 magPhase, out float phaseGain) {
  float T_src  = max(sourceFrameCount - 1.0, 1.0) / max(sourceSampleRate, 1e-6);
  float T_dest = max(destFrameCount - 1.0, 1.0) / max(destSampleRate, 1e-6);
  float scaleXPhys = physicalTimeScale(scaleX);

  float signX = scaleXPhys < 0.0 ? -1.0 : 1.0;
  float signY = scaleY < 0.0 ? -1.0 : 1.0;
  float absScaleX = abs(scaleXPhys);

  // Pitch ratio, read from the band actually sampled, so a read that wrapped
  // the pitch axis reports the frequency it landed on. The ratio splits in
  // two. The part the transform INTENDS — the continuous read position against
  // the source's geometric grid — scales the stored phase: a true pitch shift.
  // The residual between that ideal frequency and the sampled band's centre is
  // not a shift at all, only a change of carrier, and gets the additive
  // re-anchor below instead. Without the split, a paste across two different
  // band layouts detunes every dest band toward its nearest source band centre
  // and trips the noise replacement, because the grid residual masquerades as
  // a pitch shift applied to hundreds of radians of unwrapped phase.
  vec2 wrappedSourceUv = wrapUv(sourceUv);
  vec4 srcMeta  = getSourceMetadata(wrappedSourceUv);
  float srcFreqHz = srcMeta.a;
  float destFreqHz = getDestMetadata(destUv).a;
  float srcBandIdx = wrappedSourceUv.y * sourceBandCount - 0.5;
  float sampledBandIdx = sourceBandCount - 1.0 - floor((1.0 - wrappedSourceUv.y) * sourceBandCount);
  float bandFrac = srcBandIdx - sampledBandIdx;
  if (abs(bandFrac) < BAND_FRAC_DEADZONE) bandFrac = 0.0;
  float idealFreqHz = srcFreqHz * exp2(bandFrac / max(sourceBandsPerOctave, 1e-6));
  float freqRatio = (idealFreqHz > 1e-3) ? destFreqHz / idealFreqHz : 1.0;
  // Carrier re-anchor rate for the grid residual: content stored against the
  // sampled band's centre must advance against the dest band's centre instead.
  // Zero exactly when bandFrac snapped to zero.
  float mismatchHz = (idealFreqHz > 1e-3) ? destFreqHz * (srcFreqHz - idealFreqHz) / idealFreqHz : 0.0;

  float tSrcSec  = sourceUv.x * T_src;
  float tDestSec = destUv.x * T_dest;

  // Two approaches, blended by how far |scaleXPhys| is from 1:
  //
  // Additive (proven for |scaleXPhys|=1): precise carrier correction for
  // shift/reversal, but IF correction accumulates error during stretch.
  //
  // Scale-by-S (proven for |scaleXPhys|≠1): no error accumulation, every
  // pixel independent, but loses inter-band phase alignment at |scaleXPhys|=1.

  // Additive phase: signX × signY × φ + carrier correction
  float addL = signX * signY * magPhase.y;
  float addR = signX * signY * magPhase.w;
  if (scaleXPhys < 0.0) {
    float corr = contentAdvance(0.0, srcFreqHz, tSrcSec + tDestSec);
    addL += corr;
    addR += corr;
  } else {
    float corr = contentAdvance(0.0, srcFreqHz, tDestSec / max(scaleXPhys, 1e-5) - tSrcSec);
    addL += corr;
    addR += corr;
  }

  // Scale-by-S phase: scaleXPhys × signY × φ (handles stretch + reversal)
  float sclL = scaleXPhys * signY * magPhase.y;
  float sclR = scaleXPhys * signY * magPhase.w;

  // Blend: use additive near |scaleXPhys|=1, scale-by-S when stretching
  float stretchAmount = clamp(abs(absScaleX - 1.0) * 4.0, 0.0, 1.0);
  float phaseL = mix(addL, sclL, stretchAmount);
  float phaseR = mix(addR, sclR, stretchAmount);

  // Both branches carry the same signX·signY factor, so what is left of the
  // stored phase is its magnitude times the intended pitch ratio. The grid
  // residual stays out of phaseGain — a re-anchor leaves the stored phase
  // untouched, so it must not trigger the noise replacement.
  phaseGain = mix(1.0, absScaleX, stretchAmount) * freqRatio;

  // Pitch ratio scaling, then the residual carrier re-anchor.
  return vec2(phaseL, phaseR) * freqRatio + vec2(TWO_PI * mismatchHz * tDestSec);
}

vec4 getTransformedSampleNeutralPlain(vec2 sourceUv, vec2 destUv, float scaleX, float scaleY) {
  vec4 magPhase = sampleSourceInterp(wrapUv(sourceUv));
  float phaseGain;
  vec2 phase = neutralPhase(sourceUv, destUv, scaleX, scaleY, magPhase, phaseGain);
  magPhase.y = phase.x;
  magPhase.w = phase.y;
  return magPhase;
}

/**
 * Onset transport
 *
 * Transient-preserving phase rule, for any combination of pitch/time shift:
 *
 *   φ = −2π·f_dest·T_dest + parity·(φ_src + 2π·f_src·T_src)
 *
 * In the Gaborator global convention an impulse at time T has φ = −2π·f·T at
 * every atom, so the bracketed term is the source's phase DEVIATION from a
 * perfect impulse at the onset. Re-anchoring that deviation at the dest
 * frequency transports the source's transient character: coherent clicks stay
 * coherent (cross-band aligned → sharp attack, no pre-echo), noisy attacks
 * stay noisy. Purely additive — stored phase is never scaled, so the 2πn
 * unwrap ambiguity that a scaling rule turns into per-band phase junk cancels
 * mod 2π here. parity is the move's stored-phase conjugation (signX·signY):
 * a reversed or pitch-flipped move transports the conjugated deviation, so a
 * reversed attack lands as its own mirror image instead of a forward click.
 *
 * A physical stretch also smears each band's attack skirt to |S| times its
 * width — low bands sweep in early and die late, a chirp around every hit. So
 * the transport also returns a read-position warp: a piecewise map that runs
 * at slope ±1 in physical seconds inside a support-sized window around each
 * onset and at one uniform slope across the rest of the segment between
 * onsets. The transient keeps its own duration, the segment absorbs the
 * stretch evenly, and every band's read meets the segment boundaries exactly,
 * so nothing tears where the nearest onset changes.
 */
const float ONSET_SUPPORT_GAIN = 0.7;
const float ONSET_SIGMA_FLOOR  = 0.002;
// Physical stretch below which the rigid re-read stays off, so a move that
// does not stretch (shift, reversal, cross-file paste at equal tempo) keeps
// its read position bit-exactly.
const float ONSET_RIGID_DEADZONE = 1e-4;
// Rigid half-width around an onset, in units of the band's lock window sigma.
const float ONSET_RIGID_SUPPORT = 1.5;

// The stored coefficient nearest in time, rounded rather than floored. Reading
// the phase at an attack must not fall back to the silent coefficient before
// it, and each band's grid has its own stride.
vec4 sampleSourceNearest(vec2 sourceUv) {
  float strideFrames = exp2(getSourceMetadata(sourceUv).b);
  return sampleSourceNoInterp(sourceUv + vec2(0.5 * strideFrames / max(sourceFrameCount, 1.0), 0.0));
}

// Spread of the phase second difference, in radians, at which content stops
// counting as tonal.
const float TONALITY_SPREAD = 0.6;

/**
 * How tonal the source is here, 0..1. Phase is stored unwrapped along time, so
 * a steady partial advances linearly and its second difference sits near zero,
 * while noise scatters it across the whole circle. One sample of that is too
 * noisy to classify on, so it is averaged over a few coefficients of the band's
 * own grid.
 */
float sourceTonality(vec2 sourceUv) {
  float strideUv = exp2(getSourceMetadata(sourceUv).b) / max(sourceFrameCount, 1.0);
  float phases[5];
  for (int i = 0; i < 5; i++) {
    phases[i] = sampleSourceNoInterp(vec2(sourceUv.x - float(i) * strideUv, sourceUv.y)).y;
  }
  float total = 0.0;
  for (int i = 0; i < 3; i++) {
    total += abs(unwrapPhase(phases[i] - 2.0 * phases[i + 1] + phases[i + 2]));
  }
  float mean = total / 3.0;
  return exp(-(mean * mean) / (TONALITY_SPREAD * TONALITY_SPREAD));
}

// ---------------------------------------------------------------------------
// Cross-resolution resampling (source and dest analysed at different
// bands-per-octave). A nearest-band read alone duplicates each wide source
// band into several narrow dest bands (or drops fine bands into a coarse
// one): tones grow ghost partials and a level boost, noise turns into a
// correlated chorus. The rules below reshape magnitude — and, for noise, the
// phase — so the pasted canvas matches what a direct analysis of the source
// audio at the dest resolution would hold. Constants are calibrated against
// native-addon round trips (12↔60 and 24↔48 bpo, tones and noise, synthesised
// and re-analysed): each lands within ~1 dB of the direct analysis.
// ---------------------------------------------------------------------------

// Dest atom frequency response exp(-c·d²), d in the atom's own band units.
const float XRES_ATTEN_COEFF = 1.0;
// A tone's phase second difference is numerically ~0 at any resolution;
// band-limited noise wanders by >= ~0.03 rad. A fixed-radian tonality cannot
// separate the two on a coarse grid, where the bin rate oversamples the band.
const float XRES_D2_SPREAD = 0.012;
// Float32 phase quantisation grows with the unwrapped magnitude; widening the
// spread with it fails toward "tonal", the milder treatment.
const float XRES_D2_ULP = 4e-6;
// Largest source-side attenuation the tonal path may undo, in (src bands)².
const float XRES_DEV_UNDO_CAP = 1.5;
// Level makeup for the synthetic noise phase walk's residual self-cancellation.
const float XRES_NOISE_MAKEUP = 1.65;
// Noise phase block length in seconds, × destBandsPerOctave / f — the dest
// atom's own support, so the walk is band-limited at the dest band's rate.
const float XRES_BLOCK_SUPPORT = 0.7;

// Tonality and measured frequency deviation of the source at a position, from
// six stored phases on the band's own grid. Deviation comes from
// instFreqDevHz, clamped to ±FREQ_DEV_CLAMP of the centre.
void xresAnalyzeSource(vec2 sourceUv, float srcFreqHz, out float tonality, out float devHz) {
  vec4 meta = getSourceMetadata(sourceUv);
  float strideFrames = exp2(meta.b);
  float strideUv = strideFrames / max(sourceFrameCount, 1.0);
  float dtSec = strideFrames / max(sourceSampleRate, 1e-6);
  float phases[6];
  for (int i = 0; i < 6; i++) {
    phases[i] = sampleSourceNoInterp(vec2(sourceUv.x + (1.0 - float(i)) * strideUv, sourceUv.y)).y;
  }
  float total = 0.0;
  for (int i = 1; i < 4; i++) {
    total += abs(unwrapPhase(phases[i - 1] - 2.0 * phases[i] + phases[i + 1]));
  }
  float mean = total / 3.0;
  float spread = max(XRES_D2_SPREAD, abs(phases[1]) * XRES_D2_ULP);
  tonality = exp(-(mean * mean) / (spread * spread));

  float dev = instFreqDevHz(phases[2], phases[1], phases[0], dtSec);
  devHz = clamp(dev, -FREQ_DEV_CLAMP * srcFreqHz, FREQ_DEV_CLAMP * srcFreqHz);
}

// How strongly a source position sits inside an onset, in the SOURCE band's
// Gabor support — the width of the attack ridge. Effects that only move
// content in time use this to decide where a re-anchor is worth applying.
float onsetWeight(vec2 sourceUv) {
  float fSrc = max(getSourceMetadata(sourceUv).a, 1e-6);
  float tSrcSec = sourceUv.x * sourceFrameCount / max(sourceSampleRate, 1e-6);
  vec2 onset = texture(sourceOnsetTex, vec2(sourceUv.x, 0.5)).rg;
  float sigma = max(ONSET_SUPPORT_GAIN * sourceBandsPerOctave / fSrc, ONSET_SIGMA_FLOOR);
  float dt = (tSrcSec - onset.x) / sigma;
  return onset.y * exp(-dt * dt);
}

/**
 * Re-anchors a phase for content moved by dtSec seconds along the time axis,
 * within the destination's own band (so the frequency does not change). The
 * carrier correction is exact, but only worth applying at an attack: away from
 * one it is the identity anyway, and applying it costs the fetch.
 */
float reanchorTimeShift(vec2 sourceUv, float phase, float freqHz, float dtSec) {
  float w = onsetWeight(sourceUv);
  return phase + w * contentAdvance(0.0, freqHz, dtSec);
}

void onsetTransport(vec2 sourceUv, vec2 destUv, float scaleX, float parity,
                    out float w, out float anchor, out float warpDeltaUvX) {
  float fSrc  = max(getSourceMetadata(sourceUv).a, 1e-6);
  float fDest = max(getDestMetadata(destUv).a, 1e-6);

  float tSrcSec = sourceUv.x * sourceFrameCount / max(sourceSampleRate, 1e-6);
  vec4 onset = texture(sourceOnsetTex, vec2(sourceUv.x, 0.5));

  // Lock window matched to the SOURCE band's Gabor support — the width of the
  // attack ridge in the transported data. A dest-support window would cohere
  // tail energy into a false click.
  float sigma = max(ONSET_SUPPORT_GAIN * sourceBandsPerOctave / fSrc, ONSET_SIGMA_FLOOR);
  float dt = (tSrcSec - onset.x) / sigma;
  w = onset.y * exp(-dt * dt);

  // Onset time mapped into dest seconds through the transform's x-affine
  // (destUvToSourceUv slope is sourceTimeScale, the geometric transform's is
  // 1/scaleX), so the lock lands where the transient lands after the move.
  float deltaSrcUv  = (onset.x - tSrcSec) * sourceSampleRate / max(sourceFrameCount, 1.0);
  float deltaDestUv = deltaSrcUv * scaleX / max(sourceTimeScale, 1e-6);
  float tOnsetDestSec = (destUv.x + deltaDestUv) * destFrameCount / max(destSampleRate, 1e-6);

  anchor = -TWO_PI * fDest * tOnsetDestSec + parity * TWO_PI * fSrc * onset.x;

  // Rigid transient re-read: between two onsets the read map is piecewise —
  // slope ±1 in physical seconds inside a support-sized window around each
  // onset, one uniform slope across the rest of the segment. Every band's
  // read agrees at both segment boundaries, so neighbouring segments join
  // with no tear. A boundary with no onset (file edge) gets a zero-width
  // rigid zone.
  warpDeltaUvX = 0.0;
  float scaleXPhys = physicalTimeScale(scaleX);
  if (onset.y > 0.0 && abs(abs(scaleXPhys) - 1.0) > ONSET_RIGID_DEADZONE) {
    float durSec = sourceFrameCount / max(sourceSampleRate, 1e-6);
    float prevT = onset.z < 0.0 ? 0.0 : onset.z;
    float nextT = onset.w < 0.0 ? durSec : onset.w;
    // Dest times of the segment boundaries, through the same x-affine as the
    // anchor above.
    float destPerSrc = (sourceSampleRate / max(sourceFrameCount, 1.0)) * (scaleX / max(sourceTimeScale, 1e-6))
                     * (destFrameCount / max(destSampleRate, 1e-6));
    float tDestSec = destUv.x * destFrameCount / max(destSampleRate, 1e-6);
    float destPrev = tDestSec + (prevT - tSrcSec) * destPerSrc;
    float destNext = tDestSec + (nextT - tSrcSec) * destPerSrc;
    float segLen = max(nextT - prevT, 1e-6);
    float destSpan = max(abs(destNext - destPrev), 1e-6);
    float rigidCap = 0.25 * min(segLen, destSpan);
    float rPrev = onset.z < 0.0 ? 0.0 : min(ONSET_RIGID_SUPPORT * sigma, rigidCap);
    float rNext = onset.w < 0.0 ? 0.0 : min(ONSET_RIGID_SUPPORT * sigma, rigidCap);
    float dir = destNext >= destPrev ? 1.0 : -1.0;
    float xi = clamp((tDestSec - destPrev) * dir, 0.0, destSpan);
    float readSec;
    if (xi <= rPrev) {
      readSec = prevT + xi;
    } else if (xi >= destSpan - rNext) {
      readSec = nextT - (destSpan - xi);
    } else {
      float mid = (segLen - rPrev - rNext) / max(destSpan - rPrev - rNext, 1e-6);
      readSec = prevT + rPrev + mid * (xi - rPrev);
    }
    warpDeltaUvX = (readSec - tSrcSec) * sourceSampleRate / max(sourceFrameCount, 1.0);
  }
}

// How far the multiplier applied to the stored phase has to sit from 1 before
// the noise it scrambles is replaced outright. Unwrapped phase reaches hundreds
// of radians, so any multiplier but 1 leaves noise scrambled — the ramp is only
// there to keep the switch from being a step, and 1 itself is the case that
// matters: a move that preserves phase leaves the source alone. The dead zone
// is a fifty-thousandth of a cent wide, and absorbs the rounding in the
// multiplier so that "leaves alone" is exact.
const float NOISE_REPLACE_RAMP     = 100.0;
const float NOISE_REPLACE_DEADZONE = 1.0e-5;

/**
 * Algorithm 6 — Neutral (default)
 *
 * The plain neutral rule, with onset transport where the source has an onset,
 * so percussive material keeps its attacks through any pitch or time move while
 * sustained material is left as the plain rule leaves it.
 *
 * Where the transform rescales stored phase, the unwrap history it scrambles is
 * replaced with hash-random phase at the destination band's own rate for the
 * part of the content that is noise — that sounds like band-limited noise
 * rather than the slowed, watery texture scaled phase gives it. Tonal content
 * is untouched, and so is everything when the move preserves phase exactly.
 *
 * Every blend runs along the shortest arc between the two phases rather than on
 * the unit circle, so content with no onset comes out bit-identical to the plain
 * rule instead of wrapped into [-π, π], and even a fully randomized sample stays
 * near the unwrapped baseline. Phase is stored unwrapped along time, and onset
 * detection and the tonality estimate above both read differences of it.
 */
vec4 getTransformedSampleNeutral(vec2 sourceUv, vec2 destUv, float scaleX, float scaleY) {
  // Stored-phase conjugation of this move (see the phase primitives block):
  // multiplies every transported stored-phase term below, never carrier terms.
  float parity = (scaleX < 0.0 ? -1.0 : 1.0) * (scaleY < 0.0 ? -1.0 : 1.0);

  // Lock weight, phase anchor, and rigid re-read for the nearest onset, all
  // decided at the stretch-mapped read position. The warp applies before any
  // sampling, so magnitude and the transported deviation both come from the
  // rigid position.
  float w, anchor, warpDeltaUvX;
  onsetTransport(wrapUv(sourceUv), destUv, scaleX, parity, w, anchor, warpDeltaUvX);
  sourceUv.x += warpDeltaUvX;

  vec2 wrappedSourceUv = wrapUv(sourceUv);
  vec4 magPhase = sampleSourceInterp(wrappedSourceUv);

  float phaseGain;
  vec2 neutral = neutralPhase(sourceUv, destUv, scaleX, scaleY, magPhase, phaseGain);

  float baseL = neutral.x;
  float baseR = neutral.y;

  // Cross-resolution resample (see the XRES block above). Reshapes magnitude
  // and, where the content is noise, the phase; every phase edit is applied as
  // a delta on the neutral base so the rule composes with time shifts,
  // reversal, and the stretch blend.
  float bpoRatio = destBandsPerOctave / max(sourceBandsPerOctave, 1e-6);
  if (abs(bpoRatio - 1.0) > 1e-4) {
    vec4 srcMeta = getSourceMetadata(wrappedSourceUv);
    float srcFreqHz = max(srcMeta.a, 1e-6);
    float destFreqHz = max(getDestMetadata(destUv).a, 1e-6);
    float srcBandIdx = wrappedSourceUv.y * sourceBandCount - 0.5;
    float sampledBandIdx = sourceBandCount - 1.0 - floor((1.0 - wrappedSourceUv.y) * sourceBandCount);
    float bandFrac = srcBandIdx - sampledBandIdx;
    if (abs(bandFrac) < BAND_FRAC_DEADZONE) bandFrac = 0.0;
    float idealFreqHz = max(srcFreqHz * exp2(bandFrac / max(sourceBandsPerOctave, 1e-6)), 1e-6);
    float freqRatio = destFreqHz / idealFreqHz;
    float tDestSec = destUv.x * (destFrameCount - 1.0) / max(destSampleRate, 1e-6);

    if (bpoRatio > 1.0) {
      // Upsampling: ~bpoRatio dest bands read each source band. The tonal part
      // attenuates each duplicate by the dest atom's response around the
      // MEASURED frequency, undoing the source-side attenuation the read
      // arrived with; the noise part splits the band's energy across the
      // duplicates and walks its own band-limited random phase, because the
      // copied wide-band phase fluctuates too fast for the narrow dest atom
      // and cancels in the synthesis.
      float tonality, devHz;
      xresAnalyzeSource(wrappedSourceUv, srcFreqHz, tonality, devHz);
      float s = smoothstep(0.2, 0.7, tonality);

      // Offset of the content's TARGET frequency from this dest band, in dest
      // bands. Measured against the ideal read frequency rather than the dest
      // band absolute, so a transposing paste (pitch offsets, Fixed tracking)
      // carries the content to fTrue × the intended ratio instead of pinning
      // it at its source-absolute frequency.
      float fTrue = max(srcFreqHz + devHz, 1e-6);
      float offDest = destBandsPerOctave * log2(fTrue / idealFreqHz);
      float devSrc = sourceBandsPerOctave * log2(fTrue / srcFreqHz);
      float undo = min(devSrc * devSrc, XRES_DEV_UNDO_CAP);
      float tonalMag2 = exp(-2.0 * XRES_ATTEN_COEFF * (offDest * offDest - undo));
      float noiseMag2 = XRES_NOISE_MAKEUP * XRES_NOISE_MAKEUP / bpoRatio;
      float magScale = sqrt(mix(noiseMag2, tonalMag2, s));
      magPhase.x *= magScale;
      magPhase.z *= magScale;

      float blockDur = XRES_BLOCK_SUPPORT * destBandsPerOctave / destFreqHz;
      float tBlocks = tDestSec / blockDur;
      float b0 = floor(tBlocks);
      float fb = tBlocks - b0;
      float bandSeed = floor((1.0 - destUv.y) * destBandCount);
      float noiseL = TWO_PI * mix(random(vec2(bandSeed, b0)), random(vec2(bandSeed, b0 + 1.0)), fb);
      float noiseR = TWO_PI * mix(random(vec2(bandSeed + 917.0, b0)), random(vec2(bandSeed + 917.0, b0 + 1.0)), fb);
      float noiseW = 1.0 - s;
      baseL += noiseW * unwrapPhase(noiseL - baseL);
      baseR += noiseW * unwrapPhase(noiseR - baseR);
    } else {
      // Downsampling: project every fine band the coarse dest atom covers.
      // Tonal content sums amplitudes (coherent taps, normalised so a tone
      // maps to its true coarse coefficient); noise sums power. The phase
      // comes from the LOUDEST tap — the nearest one can be silent, and
      // magnitude written with junk phase cancels in the synthesis.
      float halfSpan = 0.5 / bpoRatio + 3.0;
      vec2 power = vec2(0.0);
      vec2 ampSum = vec2(0.0);
      vec2 maxMag = vec2(0.0);
      vec2 maxPhase = vec2(magPhase.y, magPhase.w);
      vec2 maxFreq = vec2(srcFreqHz);
      for (int h = -8; h <= 8; h++) {
        if (abs(float(h) - bandFrac) > halfSpan) continue;
        vec2 tapUv = vec2(wrappedSourceUv.x,
                          clamp(wrappedSourceUv.y + float(h) / max(sourceBandCount, 1.0), 0.0, 1.0));
        vec4 tap = sampleSourceInterp(tapUv);
        float dCoarse = (float(h) - bandFrac) * bpoRatio;
        float w = exp(-XRES_ATTEN_COEFF * dCoarse * dCoarse);
        vec2 m = vec2(tap.x, tap.z) * w;
        power += m * m;
        ampSum += m;
        float tapFreq = srcFreqHz * exp2(float(h) / max(sourceBandsPerOctave, 1e-6));
        if (m.x > maxMag.x) { maxMag.x = m.x; maxPhase.x = tap.y; maxFreq.x = tapFreq; }
        if (m.y > maxMag.y) { maxMag.y = m.y; maxPhase.y = tap.w; maxFreq.y = tapFreq; }
      }
      vec2 peakiness = maxMag * maxMag / max(power, vec2(1e-20));
      vec2 s2 = smoothstep(vec2(0.3), vec2(0.7), peakiness);
      vec2 tonalMag = sqrt(XRES_ATTEN_COEFF / PI) * ampSum;
      vec2 newMag = sqrt(mix(power, tonalMag * tonalMag, s2));
      magPhase.x = newMag.x;
      magPhase.z = newMag.y;
      // Swap the centre tap's stored phase for the loudest tap's, carried
      // through the same intended-ratio and carrier-rebase terms.
      baseL += parity * freqRatio * (maxPhase.x - magPhase.y)
             + TWO_PI * destFreqHz * (maxFreq.x - srcFreqHz) / idealFreqHz * tDestSec;
      baseR += parity * freqRatio * (maxPhase.y - magPhase.w)
             + TWO_PI * destFreqHz * (maxFreq.y - srcFreqHz) / idealFreqHz * tDestSec;
    }
  }

  float replace = clamp((abs(phaseGain - 1.0) - NOISE_REPLACE_DEADZONE) * NOISE_REPLACE_RAMP, 0.0, 1.0);
  if (replace > 0.0) {
    float noise = replace * (1.0 - sourceTonality(wrappedSourceUv));
    vec2 seed = destUv * vec2(destFrameCount, destBandCount);
    float randL = random(seed + random(seed + vec2(12.34, 56.78))) * TWO_PI;
    float randR = random(seed + random(seed + vec2(90.12, 34.56))) * TWO_PI;
    baseL += noise * unwrapPhase(randL - baseL);
    baseR += noise * unwrapPhase(randR - baseR);
  }

  // The deviation being transported comes from the nearest stored coefficient,
  // not the interpolated phase: interpolating phase across an attack averages
  // two atoms that disagree, which is the whole reason a moved transient smears
  // even when the carrier correction is exact.
  vec4 nearest = sampleSourceNearest(wrappedSourceUv);

  magPhase.y = baseL + w * unwrapPhase(anchor + parity * nearest.y - baseL);
  magPhase.w = baseR + w * unwrapPhase(anchor + parity * nearest.w - baseR);
  return magPhase;
}

vec4 getTransformedSample(vec2 sourceUv, vec2 destUv, float scaleX, float scaleY, float shiftX, float shiftY) {
  vec2 wrappedSourceUv = wrapUv(sourceUv);

  if (algorithm == 0) {
    return getTransformedSampleBasic(wrappedSourceUv, false, scaleX, destUv);
  } else if (algorithm == 1) {
    return getTransformedSampleBasic(wrappedSourceUv, true, scaleX, destUv);
  } else if (algorithm == 2) {
    return getTransformedSampleSnappy(wrappedSourceUv, true, destUv, scaleX);
  } else if (algorithm == 3) {
    return getTransformedSampleNeutralish(sourceUv, destUv, scaleX, scaleY, shiftX, shiftY);
  } else if (algorithm == 4) {
    // The plain rule with no onset transport and no noise replacement: the
    // baseline algorithm 6 is defined against, reachable for tests but not
    // offered in the menu.
    return getTransformedSampleNeutralPlain(sourceUv, destUv, scaleX, scaleY);
  }
  // Anything else, including values stored before an algorithm was retired,
  // paints with the default rather than writing silence.
  return getTransformedSampleNeutral(sourceUv, destUv, scaleX, scaleY);
}

// ============================================================================
// BRUSH & BLENDING
// ============================================================================

// Continuous envelope shape: spike (curve=-1) to linear triangle (curve=0) to
// hard rectangle (curve=+1). Skew places the peak along the axis: 0=start, 1=end.
// Two-branch formulation keeps the peak at 1 across the whole curve range.
float calculateEnvelopeGain(float localPos, float curve, float skew) {
  if (localPos < 0.0 || localPos > 1.0) return 0.0;
  float c = clamp(curve, -1.0, 1.0);
  float s = clamp(skew, 0.0, 1.0);
  float leftW  = max(s, EPSILON);
  float rightW = max(1.0 - s, EPSILON);
  float x = localPos < s ? (s - localPos) / leftW : (localPos - s) / rightW;
  if (x <= 0.0) return 1.0;
  if (x >= 1.0) return 0.0;
  if (c >= 0.0) {
    // Rectangle branch: p → ∞ at curve=1 collapses to a hard rectangle (visible).
    float p = 1.0 / max(1.0 - c, EPSILON);
    return 1.0 - pow(x, p);
  }
  // Spike branch: cap the exponent so the narrowest peak still has visible area.
  // 0.98 scaling caps p at 50 at curve=-1 (~2% wide spike).
  float p = 1.0 / max(1.0 + c * 0.98, EPSILON);
  return pow(1.0 - x, p);
}

// Time-axis brush coverage by edge-of-bin membership: a bin is inside the
// brush iff its left edge k·2^step falls within the span [0, brushSizeUv.x).
// The left edge is where the bin's coefficient actually sits — the analysis
// atom is centered there, the inverse map addresses it there, and the display
// draws it there — so painted energy stays centered under the brush at every
// band instead of ringing half a bin early at coarse bands. Every band's bins
// share the frame-0 origin and step by a power of two, so equal adjacent
// stamps still partition each band's bins exactly (half-open span, one owner
// per bin). Returns coverage as 0.0 or 1.0 and outputs localX, the bin edge's
// position within the span, for the envelope.
float getBrushTimeCoverage(vec2 unpackedUv, vec4 meta, out float localX) {
  float cellFrames = exp2(meta.b);
  float bandLength = meta.g;

  // Recover the fragment's frame as a whole number before choosing its bin.
  // The inverse map stores an exact integer frame, but it reaches the shader
  // divided by frameCount and is multiplied back here, and that float32 round
  // trip can land a hair low — frame 256 comes back as 255.99998. A plain
  // floor() then attributes the fragment to the previous bin, which at a stamp
  // edge means neither stamp claims it and one coefficient per band survives
  // the stroke untouched. Snapping to the frame first, then biasing the
  // division by half a frame, keeps containment semantics for any UV while
  // making bin-aligned ones exact.
  float pixelFrame = floor(unpackedUv.x * destFrameCount + 0.5);
  float binIndex = clamp(floor((pixelFrame + 0.5) / cellFrames), 0.0, bandLength - 1.0);
  float binEdgeUv  = binIndex * cellFrames / destFrameCount;
  float binWidthUv = cellFrames / destFrameCount;

  // Membership is decided in whole frames, not in UV. A bin edge is an exact
  // integer frame, and rounding the brush's own edges to frames makes one
  // stamp's end and the next one's start round to the SAME integer — so every
  // bin has exactly one owner. Comparing the UV floats instead leaves cracks: a
  // stamp's end and its neighbour's start are computed by different expressions
  // whose last bits differ, and a bin edge landing on that boundary can be
  // disowned by both, which drops one coefficient per band at the seam.
  float blFrame = floor(brushBottomLeftUv.x * destFrameCount + 0.5);
  float endFrame = floor((brushBottomLeftUv.x + brushSizeUv.x) * destFrameCount + 0.5);
  float spanFrames = endFrame - blFrame;
  float edgeFrame = binIndex * cellFrames;
  float offFrames = edgeFrame - blFrame;
  // On a wrapping axis the span continues from the far edge of the canvas, so
  // fold the offset there — in frames, where it stays exact.
  if (wrapsTimeAxis()) offFrames = mod(offFrames + destFrameCount, destFrameCount);
  float edgeOff = offFrames / destFrameCount;
  // The envelope samples at the center of the bin's overlap with the span, not
  // at the bin's own center: either endpoint of the envelope is a hard zero, so
  // a bin clipped by the span — its edge inside but its center past the end, or
  // the reverse at the start — would clamp onto that zero and drop out,
  // leaving an unpainted sliver at every seam between adjacent grid stamps. The
  // overlap center is strictly inside the span for every bin the membership test
  // admits, and equals the bin center for bins the span wholly contains, so
  // stroke fade shapes are unchanged.
  float overlapStart = max(offFrames, 0.0);
  float overlapEnd = min(offFrames + cellFrames, spanFrames);
  localX = clamp(0.5 * (overlapStart + overlapEnd) / max(EPSILON, spanFrames), 0.0, 1.0);

  bool inside = offFrames >= 0.0 && offFrames < spanFrames;
  // Sub-bin fallback: a brush narrower than this band's cell can contain no bin
  // edge, which would stripe the wide low-frequency bands during a drag. When
  // that happens, paint the single bin whose coefficient is nearest the brush's
  // own center.
  bool fallback = brushSizeUv.x < binWidthUv
               && abs(edgeOff - brushSizeUv.x * 0.5) < 0.5 * binWidthUv;

  return (inside || fallback) ? 1.0 : 0.0;
}

// Returns vec2(weightL, weightR) — brush weight can decorrelate per channel
// when the modulators driving envelope curve/skew have non-zero stereo spread.
vec2 getBrushWeight(vec2 unpackedUv, float audioLevelDb) {
  vec4 meta = getDestMetadata(unpackedUv);

  vec2 off = getEffectiveBrushOffset(unpackedUv);
  vec2 safeBrush = max(vec2(EPSILON), brushSizeUv);

  vec2 brushMods[NUM_MODULATORS];
  sampleModulators(brushMods);
  vec2 curveX = applyModulationCached(
    brushCurveTime.value, brushCurveTime.minValue, brushCurveTime.maxValue,
    brushCurveTime.modulationAmounts, brushCurveTime.contextualModAmounts, brushCurveTime.macroAmounts, brushMods
  );
  vec2 skewX = applyModulationCached(
    brushSkewTime.value, brushSkewTime.minValue, brushSkewTime.maxValue,
    brushSkewTime.modulationAmounts, brushSkewTime.contextualModAmounts, brushSkewTime.macroAmounts, brushMods
  );
  vec2 curveY = applyModulationCached(
    brushCurvePitch.value, brushCurvePitch.minValue, brushCurvePitch.maxValue,
    brushCurvePitch.modulationAmounts, brushCurvePitch.contextualModAmounts, brushCurvePitch.macroAmounts, brushMods
  );
  vec2 skewY = applyModulationCached(
    brushSkewPitch.value, brushSkewPitch.minValue, brushSkewPitch.maxValue,
    brushSkewPitch.modulationAmounts, brushSkewPitch.contextualModAmounts, brushSkewPitch.macroAmounts, brushMods
  );

  // X (time): edge-of-bin membership so adjacent grid stamps tile each band
  // exactly. coverage is 0 or 1; the envelope shapes the weight across the span.
  float localX;
  float coverage = getBrushTimeCoverage(unpackedUv, meta, localX);

  vec2 weightX = vec2(0.0);
  if (coverage > 0.0) {
    weightX.x = calculateEnvelopeGain(localX, curveX.x, skewX.x);
    weightX.y = calculateEnvelopeGain(localX, curveX.y, skewX.y);
  }

  // Y (pitch): band center position relative to brush.
  float localY = off.y / safeBrush.y;
  vec2 weightY = vec2(
    calculateEnvelopeGain(localY, curveY.x, skewY.x),
    calculateEnvelopeGain(localY, curveY.y, skewY.y)
  );

  return weightX * weightY;
}

bool isInsideBrush(vec2 unpackedUv) {
  vec2 offset = getEffectiveBrushOffset(unpackedUv);

  // Pitch axis: bottom-left reference, offset within [0, brushSizeUv.y).
  if (brushSizeUv.y > 0.0 && (offset.y < 0.0 || offset.y >= brushSizeUv.y)) {
    return false;
  }
  // Time axis: same edge-of-bin membership the brush weight uses, so the
  // footprint test and the painted region agree bin-for-bin at every band.
  if (brushSizeUv.x > 0.0) {
    float localX;
    if (getBrushTimeCoverage(unpackedUv, getDestMetadata(unpackedUv), localX) <= 0.0) {
      return false;
    }
  }
  return true;
}

// Source-space counterpart of isInsideBrush: invert the freq-preserving map
// back to dest UV and delegate to the dest-space check. Needed whenever
// source/dest were analyzed with different band layouts — a plain dest-space
// check on a source UV rejects valid samples when the mapping is nonlinear.
bool isInsideSourceBrush(vec2 sourceUv) {
  return isInsideBrush(sourceUvToDestUv(sourceUv));
}

// Conservative test for fragments whose brush weight is provably zero, derived
// from getBrushWeight's exact zero conditions: weightY is zero when off.y leaves
// [0, brushSizeUv.y], weightX is zero when the time coverage is zero (the bin
// center is outside the span and the sub-bin fallback does not apply). Runs
// before the expensive per-fragment work (modulator sampling, source reads), so
// the large packed regions outside the brush — which dominate high-frequency
// bands where the scissor over-covers — bail after one unpack and metadata
// fetch. Never rejects a fragment that getBrushWeight would score above zero.
bool brushWeightIsZero(vec2 unpackedUv) {
#ifdef ABLATE_BRUSH_REJECT
  return false;
#else
  vec2 off = getEffectiveBrushOffset(unpackedUv);
  float safeBrushY = max(EPSILON, brushSizeUv.y);
  if (off.y < 0.0 || off.y > safeBrushY) return true;
  float localX;
  return getBrushTimeCoverage(unpackedUv, getDestMetadata(unpackedUv), localX) <= 0.0;
#endif
}

// Applies the final brush effect, combining original and modified data.
// packedUv is the raw texture coordinate (vUv), destUv is the unpacked spectrogram coordinate
// weight is vec2(L, R) — each channel carries its own brush envelope weight so
// modulators driving brush shape parameters can decorrelate the two channels.
vec4 applyBrush(vec4 original, vec4 modified, vec2 weight, vec2 destUv, vec2 packedUv) {
  vec2 originalL = original.rg;
  vec2 originalR = original.ba;
  vec2 modifiedL = modified.rg;
  vec2 modifiedR = modified.ba;

  // For non-cumulative mode with additive blend modes, use the stroke start state
  // for blend formula calculations to prevent accumulation when painting over the same area
  // Note: blendOriginal is only used for computing the blend target, not for the final interpolation
  // Use packedUv for sampling textures that are in packed format
  vec2 blendOriginalL = originalL;
  vec2 blendOriginalR = originalR;
  if (useStrokeMask) {
    vec4 strokeStart = texture(blendOriginalTex, packedUv);
    blendOriginalL = strokeStart.rg;
    blendOriginalR = strokeStart.ba;
  }

  float audioLevelDb = getAudioLevelDb(destUv);

  vec2 brushMods[NUM_MODULATORS];
  sampleModulators(brushMods);
  vec2 intensity = applyModulationCached(
    brushIntensity.value, brushIntensity.minValue, brushIntensity.maxValue,
    brushIntensity.modulationAmounts, brushIntensity.contextualModAmounts, brushIntensity.macroAmounts, brushMods
  );

  vec2 pan = applyModulationCached(
    brushPan.value, brushPan.minValue, brushPan.maxValue,
    brushPan.modulationAmounts, brushPan.contextualModAmounts, brushPan.macroAmounts, brushMods
  );

  vec2 pannedModifiedL = fromPolar(getMag(modifiedL) * clamp(1.0 - pan.x, 0.0, 1.0), getPhase(modifiedL));
  vec2 pannedModifiedR = fromPolar(getMag(modifiedR) * clamp(1.0 + pan.y, 0.0, 1.0), getPhase(modifiedR));

  vec2 effectiveWeight = bypassBrushWeight ? vec2(1.0) : weight * intensity;

  // Non-cumulative stroke: use the max weight seen at this pixel
  // Since we always blend from strokeStart, using max(current, stored) ensures:
  // - Gradual reveal as we paint (weight increases)
  // - No accumulation beyond intensity (mask caps the weight)
  // - Consistent result when re-painting same area (same blend from strokeStart)
  // Use packedUv to sample the mask since it's stored in packed format
  if (useStrokeMask) {
    float maskValue = texture(strokeMaskTex, packedUv).r;
    effectiveWeight = max(effectiveWeight, vec2(maskValue));
  }

  // Dissolve (stochastic)
  if (blendMode == 8) {
    vec2 finalL = (random(destUv.xy) < effectiveWeight.x) ? pannedModifiedL : originalL;
    vec2 finalR = (random(destUv.yx) < effectiveWeight.y) ? pannedModifiedR : originalR;
    finalL = limitMagnitude(finalL);
    finalR = limitMagnitude(finalR);
    return vec4(finalL, finalR);
  }

  float magModifiedL = getMag(pannedModifiedL);
  float magModifiedR = getMag(pannedModifiedR);

  // Use blendOriginal for blend formula calculations (prevents accumulation in non-cumulative mode)
  float magBlendOriginalL = getMag(blendOriginalL);
  float magBlendOriginalR = getMag(blendOriginalR);
  float phaseBlendOriginalL = getPhase(blendOriginalL);
  float phaseBlendOriginalR = getPhase(blendOriginalR);

  // Screen mode uses magnitudeLimit as the saturation reference; fall back to 1 when disabled.
  float screenLimit = magnitudeLimit > 0.0 ? magnitudeLimit : 1.0;

  vec2 targetL, targetR;

  if      (blendMode == 0) {
    // Mix — interpolateComplex handles mag/phase blending between original and modified.
    targetL = pannedModifiedL;
    targetR = pannedModifiedR;
  }
  else if (blendMode == 1) {
    // Add — complex vector sum, keeping true phase of sum.
    vec2 sumL = toComplex(blendOriginalL) + toComplex(pannedModifiedL);
    vec2 sumR = toComplex(blendOriginalR) + toComplex(pannedModifiedR);
    targetL = polarFromComplex(sumL);
    targetR = polarFromComplex(sumR);
  }
  else if (blendMode == 2) {
    // Subtract — magnitude-space scoop, keep origin phase.
    targetL = fromPolar(max(magBlendOriginalL - magModifiedL, 0.0), phaseBlendOriginalL);
    targetR = fromPolar(max(magBlendOriginalR - magModifiedR, 0.0), phaseBlendOriginalR);
  }
  else if (blendMode == 3) {
    // Multiply — spectral cross-synthesis: modifier is envelope, original is phase.
    targetL = fromPolar(magBlendOriginalL * magModifiedL, phaseBlendOriginalL);
    targetR = fromPolar(magBlendOriginalR * magModifiedR, phaseBlendOriginalR);
  }
  else if (blendMode == 4) {
    // Divide — spectral whitening / inverse EQ, keep origin phase.
    targetL = fromPolar(magBlendOriginalL / (magModifiedL + EPSILON), phaseBlendOriginalL);
    targetR = fromPolar(magBlendOriginalR / (magModifiedR + EPSILON), phaseBlendOriginalR);
  }
  else if (blendMode == 5) {
    // Maximum — pick the louder sample entirely.
    targetL = (magModifiedL > magBlendOriginalL) ? pannedModifiedL : blendOriginalL;
    targetR = (magModifiedR > magBlendOriginalR) ? pannedModifiedR : blendOriginalR;
  }
  else if (blendMode == 6) {
    // Minimum — pick the quieter sample entirely.
    targetL = (magModifiedL < magBlendOriginalL) ? pannedModifiedL : blendOriginalL;
    targetR = (magModifiedR < magBlendOriginalR) ? pannedModifiedR : blendOriginalR;
  }
  else if (blendMode == 7) {
    // Difference — symmetric magnitude subtraction, keep origin phase.
    targetL = fromPolar(abs(magBlendOriginalL - magModifiedL), phaseBlendOriginalL);
    targetR = fromPolar(abs(magBlendOriginalR - magModifiedR), phaseBlendOriginalR);
  }
  // blendMode == 8 (Dissolve) is handled above via early return.
  else if (blendMode == 9) {
    // Mask — relative-energy gate, self-normalizing.
    float denomL = magBlendOriginalL + magModifiedL + EPSILON;
    float denomR = magBlendOriginalR + magModifiedR + EPSILON;
    targetL = fromPolar(magBlendOriginalL * (magModifiedL / denomL), phaseBlendOriginalL);
    targetR = fromPolar(magBlendOriginalR * (magModifiedR / denomR), phaseBlendOriginalR);
  }
  else if (blendMode == 10) {
    // Screen — Photoshop-style brightening with magnitudeLimit as saturation reference.
    float screenL = screenLimit * (1.0 - (1.0 - magBlendOriginalL / screenLimit) * (1.0 - magModifiedL / screenLimit));
    float screenR = screenLimit * (1.0 - (1.0 - magBlendOriginalR / screenLimit) * (1.0 - magModifiedR / screenLimit));
    targetL = fromPolar(screenL, phaseBlendOriginalL);
    targetR = fromPolar(screenR, phaseBlendOriginalR);
  }
  else {
    targetL = blendOriginalL;
    targetR = blendOriginalR;
  }

  vec2 finalL, finalR;
  if (useLinearBlend) {
    finalL = mix(blendOriginalL, targetL, effectiveWeight.x);
    finalR = mix(blendOriginalR, targetR, effectiveWeight.y);
  } else {
    finalL = interpolateComplex(blendOriginalL, targetL, effectiveWeight.x);
    finalR = interpolateComplex(blendOriginalR, targetR, effectiveWeight.y);
  }

  // FINAL LIMITING
  finalL = limitMagnitude(finalL);
  finalR = limitMagnitude(finalR);

  vec4 final = vec4(finalL, finalR);

  if (any(isnan(final)) || any(isinf(final))) {
    return vec4(0.0);
  }

  return final;
}