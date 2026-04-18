// ============================================================================
// UNIFORMS & STRUCTS
// ============================================================================

#include "common.glsl"

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

uniform vec2  brushBottomLeftUv;
uniform vec2  brushSizeUv;
uniform float viewZoomPower;
uniform float viewOffset;
uniform float viewZoomPowerY;
uniform float viewOffsetY;
uniform float envelopeDelayEndX;
uniform float envelopeAttackEndX;
uniform float envelopeSustainEndX;
uniform float envelopeReleaseEndX;
uniform float envelopeDelayEndY;
uniform float envelopeAttackEndY;
uniform float envelopeSustainEndY;
uniform float envelopeReleaseEndY;
uniform float sourceOffsetX;
uniform float sourceOffsetY;
uniform float sourceTimeScale;
uniform float sourceBandScale;
uniform Parameter sourceTimeOffset;
uniform Parameter sourcePitchOffset;
uniform Parameter brushPan;
uniform Parameter brushIntensity;
uniform int   blendMode;
uniform int   wrapMode; // 0=Off, 1=Wrap X, 2=Wrap Y, 3=Wrap Both
uniform int   algorithm;
uniform bool  useLinearBlend;

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

/**
 * Applies a soft-clipping saturation curve to the magnitude (prevents runaway values).
 */
vec2 limitMagnitude(vec2 magPhase) {
  if (magnitudeLimit <= 0.0) return magPhase;

  float mag = getMag(magPhase);
  if (mag <= magnitudeLimit) return magPhase;

  float excessMag       = mag - magnitudeLimit;
  float saturatedExcess = magnitudeLimit * tanh(excessMag / magnitudeLimit);
  float newMag          = magnitudeLimit + saturatedExcess;
  return vec2(newMag, magPhase.y);
}

// Calculate wrapped distance between two points on an axis
float wrappedDistance(float a, float b, bool shouldWrap) {
  if (!shouldWrap) return abs(a - b);
  float dist       = abs(a - b);
  float wrappedDist= 1.0 - dist;
  return min(dist, wrappedDist);
}

// Wraps UV coordinates based on the wrap mode
vec2 wrapUv(vec2 uv) {
  vec2 wrapped = uv;
  if (wrapMode == 1 || wrapMode == 3) wrapped.x = fract(uv.x);
  if (wrapMode == 2 || wrapMode == 3) wrapped.y = fract(uv.y);
  return wrapped;
}

// ============================================================================
// COORDINATE UTILITIES
// ============================================================================

struct ProcessingUvs {
  vec2 dest;   // Unpacked UV we are writing TO
  vec2 source; // Unpacked UV we are sampling FROM
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

// Interpolate between two magnitude/phase pairs (log-mag, linear-phase)
vec2 interpolateComplex(vec2 magPhase1, vec2 magPhase2, float amount) {
  float magMix   = exp(mix(log(magPhase1.x + 1e-9), log(magPhase2.x + 1e-9), amount));
  float phaseMix = mix(magPhase1.y, magPhase2.y, amount);
  return vec2(magMix, phaseMix);
}

/**
 * Interpolated read between two time samples (uses texelFetch for the exact texels).
 */
vec4 readPackedDataInterpolated(vec2 unpackedUv,
                                sampler2D dataTex,
                                sampler2D metaTex,
                                float frameCount,
                                float bandCount,
                                bool centerBins) {
  float bandIndex = floor((1.0 - unpackedUv.y) * bandCount);

  vec4 meta = fetchBandMetadata(metaTex, bandIndex);
  float bandStartOffset  = meta.r;
  float bandLength       = meta.g;
  float bandTimeScaleExp = meta.b;

  float timeInFrames = unpackedUv.x * frameCount;
  if (centerBins) {
    float bandTimeScale = exp2(bandTimeScaleExp);
    timeInFrames -= bandTimeScale / 2.0;
  }
  float scaledTime = timeInFrames / exp2(bandTimeScaleExp);
  scaledTime = clamp(scaledTime, 0.0, bandLength - 1.0);

  float timeIndexFloor = floor(scaledTime);
  float timeFraction   = fract(scaledTime);

  ivec2 texSize    = textureSize(dataTex, 0);
  float widthFloat = float(max(texSize.x, 1));

  float linearIndex1 = bandStartOffset + timeIndexFloor;
  int px1 = int(mod(linearIndex1, widthFloat));
  int py1 = int(floor(linearIndex1 / widthFloat));
  px1 = clamp(px1, 0, max(texSize.x - 1, 0));
  py1 = clamp(py1, 0, max(texSize.y - 1, 0));
  vec4 sample1 = texelFetch(dataTex, ivec2(px1, py1), 0);

  float linearIndex2 = bandStartOffset + timeIndexFloor + 1.0;
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
  return readPackedDataInterpolated(sourceUv, sourceSpectrogramTex, sourceMetadataTex, sourceFrameCount, sourceBandCount, false);
}

vec4 sampleSourceInterpCentered(vec2 sourceUv) {
  return readPackedDataInterpolated(sourceUv, sourceSpectrogramTex, sourceMetadataTex, sourceFrameCount, sourceBandCount, true);
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

ProcessingUvs getProcessingUvs(vec2 destPackedUv) {
  ProcessingUvs uvs;
  uvs.dest = packedToUnpackedUv(destInverseMapTex, destPackedUv, destFrameCount, destBandCount);

  float modTimeOff = applyModulation(
    sourceTimeOffset.value, sourceTimeOffset.minValue, sourceTimeOffset.maxValue,
    sourceTimeOffset.modulationAmounts, sourceTimeOffset.contextualModAmounts,
    uvs.dest, 0, 0.0
  );
  float modPitchOff = applyModulation(
    sourcePitchOffset.value, sourcePitchOffset.minValue, sourcePitchOffset.maxValue,
    sourcePitchOffset.modulationAmounts, sourcePitchOffset.contextualModAmounts,
    uvs.dest, 0, 0.0
  );

  uvs.source = vec2(uvs.dest.x * sourceTimeScale, uvs.dest.y * sourceBandScale)
             + vec2(sourceOffsetX + modTimeOff, sourceOffsetY + modPitchOff);
  return uvs;
}

/**
 * Samples from the original, unmodified destination spectrogram with interpolation.
 */
vec4 getOriginalDestSample(vec2 destUv) {
  vec2 wrappedUv = wrapUv(destUv);
  return readPackedDataInterpolated(wrappedUv, originalSpectrogramTex, destMetadataTex, destFrameCount, destBandCount, false);
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
  float timeIndexFloor = floor(scaledTime);
  float timeFraction   = fract(scaledTime);

  ivec2 sSize    = textureSize(sourceSpectrogramTex, 0);
  float widthF   = float(max(sSize.x, 1));

  float linearIndex1 = bandStartOffset + timeIndexFloor;
  int px1 = int(mod(linearIndex1, widthF));
  int py1 = int(floor(linearIndex1 / widthF));
  px1 = clamp(px1, 0, max(sSize.x - 1, 0));
  py1 = clamp(py1, 0, max(sSize.y - 1, 0));
  vec4 sample0 = texelFetch(sourceSpectrogramTex, ivec2(px1, py1), 0);

  float linearIndex2 = bandStartOffset + timeIndexFloor + 1.0;
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
    float phaseShift = TWO_PI * destFreqHz * (destFrameCount - 1.0) / destSampleRate;
    correctedL.y = -correctedL.y - phaseShift;
    correctedR.y = -correctedR.y - phaseShift;
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
  float timeIndexFloor = floor(scaledTime);
  float timeFraction   = fract(scaledTime);

  ivec2 sSize    = textureSize(sourceSpectrogramTex, 0);
  float widthF   = float(max(sSize.x, 1));

  float linearIndex1 = bandStartOffset + timeIndexFloor;
  int px1 = int(mod(linearIndex1, widthF));
  int py1 = int(floor(linearIndex1 / widthF));
  px1 = clamp(px1, 0, max(sSize.x - 1, 0));
  py1 = clamp(py1, 0, max(sSize.y - 1, 0));
  vec4 smp0 = texelFetch(sourceSpectrogramTex, ivec2(px1, py1), 0);

  float linearIndex2 = bandStartOffset + timeIndexFloor + 1.0;
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
    float phaseShift = TWO_PI * destFreqHz * (destFrameCount - 1.0) / destSampleRate;
    correctedL.y = -correctedL.y - phaseShift;
    correctedR.y = -correctedR.y - phaseShift;
  }

  return vec4(correctedL, correctedR);
}

vec4 getTransformedSampleNeutral(vec2 sourceUv, vec2 destUv, float scaleX, float scaleY, float shiftX, float shiftY) {
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
 * Algorithm 4 — Neutral
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
 * For pitch change, multiplying by freqRatio = f_dst/f_src scales all
 * phase advance rates to match the target frequency.
 *
 * For time shift, a band-frequency carrier correction is added to
 * compensate for the synthesis happening at a different absolute time.
 */
vec4 getTransformedSampleNeutralV2(vec2 sourceUv, vec2 destUv, float scaleX, float scaleY) {
  vec4 magPhase = sampleSourceInterp(wrapUv(sourceUv));

  float signX = scaleX < 0.0 ? -1.0 : 1.0;
  float signY = scaleY < 0.0 ? -1.0 : 1.0;
  float absScaleX = abs(scaleX);

  // Frequency ratio for pitch scaling
  vec4 srcMeta  = getSourceMetadata(sourceUv);
  float srcFreqHz = srcMeta.a;
  float destFreqHz = getDestMetadata(destUv).a;
  float freqRatio = (srcFreqHz > 1e-3) ? destFreqHz / srcFreqHz : 1.0;
  float T_total = (destFrameCount - 1.0) / destSampleRate;

  // Two approaches, blended by how far |scaleX| is from 1:
  //
  // Additive (proven for |scaleX|=1): precise carrier correction for
  // shift/reversal, but IF correction accumulates error during stretch.
  //
  // Scale-by-S (proven for |scaleX|≠1): no error accumulation, every
  // pixel independent, but loses inter-band phase alignment at |scaleX|=1.

  // Additive phase: signX × signY × φ + carrier correction
  float addL = signX * signY * magPhase.y;
  float addR = signX * signY * magPhase.w;
  if (scaleX < 0.0) {
    float corr = -TWO_PI * srcFreqHz * (sourceUv.x + destUv.x) * T_total;
    addL += corr;
    addR += corr;
  } else {
    float shiftOffset = sourceUv.x - destUv.x / max(scaleX, 1e-5);
    float corr = TWO_PI * srcFreqHz * shiftOffset * T_total;
    addL += corr;
    addR += corr;
  }

  // Scale-by-S phase: scaleX × signY × φ (handles stretch + reversal)
  float sclL = scaleX * signY * magPhase.y;
  float sclR = scaleX * signY * magPhase.w;

  // Blend: use additive near |scaleX|=1, scale-by-S when stretching
  float stretchAmount = clamp(abs(absScaleX - 1.0) * 4.0, 0.0, 1.0);
  float phaseL = mix(addL, sclL, stretchAmount);
  float phaseR = mix(addR, sclR, stretchAmount);

  // Pitch ratio scaling
  phaseL *= freqRatio;
  phaseR *= freqRatio;

  magPhase.y = phaseL;
  magPhase.w = phaseR;
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
    return getTransformedSampleNeutral(sourceUv, destUv, scaleX, scaleY, shiftX, shiftY);
  } else if (algorithm == 4) {
    return getTransformedSampleNeutralV2(sourceUv, destUv, scaleX, scaleY);
  }
  return vec4(0.0);
}

// ============================================================================
// BRUSH & BLENDING
// ============================================================================

vec2 getEffectiveBrushOffset(vec2 unpackedUv) {
  vec2 offset = unpackedUv - brushBottomLeftUv;
  vec2 wrappedOffset = fract(offset);

  if(wrapMode == 0) return offset;
  else if(wrapMode == 1) return vec2(wrappedOffset.x, offset.y);
  else if(wrapMode == 2) return vec2(offset.x, wrappedOffset.y);
  
  return vec2(wrappedOffset.x, wrappedOffset.y);
}

// Calculate envelope gain for a single dimension using pre-calculated stage boundaries
float calculateEnvelopeGain(float localPos, float delayEnd, float attackEnd, float sustainEnd, float releaseEnd) {
  float gain = 0.0;
  
  if (localPos < delayEnd) {
    // Delay phase: gain = 0
    gain = 0.0;
  } else if (localPos < attackEnd) {
    // Attack phase: ramp from 0 to 1
    float attackDuration = attackEnd - delayEnd;
    if (attackDuration > EPSILON) {
      float attackProgress = (localPos - delayEnd) / attackDuration;
      gain = smoothstep(0.0, 1.0, attackProgress);
    } else {
      gain = 1.0;
    }
  } else if (localPos < sustainEnd) {
    // Sustain phase: gain = 1
    gain = 1.0;
  } else if (localPos < releaseEnd) {
    // Release phase: ramp from 1 to 0
    float releaseDuration = releaseEnd - sustainEnd;
    if (releaseDuration > EPSILON) {
      float releaseProgress = (localPos - sustainEnd) / releaseDuration;
      gain = 1.0 - smoothstep(0.0, 1.0, releaseProgress);
    } else {
      gain = 0.0;
    }
  } else {
    // Beyond envelope
    gain = 0.0;
  }
  
  return gain;
}

float getBrushWeight(vec2 unpackedUv) {
  vec4 meta = getDestMetadata(unpackedUv);
  float binWidth = exp2(meta.b) / destFrameCount;

  vec2 off = getEffectiveBrushOffset(unpackedUv);
  vec2 safeBrush = max(vec2(EPSILON), brushSizeUv);

  // X (time): compute overlap between bin [off.x, off.x+binWidth] and brush [0, brushSizeUv.x].
  // Evaluate the envelope at the center of the overlap region rather than the bin center.
  // This ensures a brush narrower than half a bin still affects bins it overlaps.
  float overlapLeft  = max(0.0, off.x);
  float overlapRight = min(brushSizeUv.x, off.x + binWidth);
  float overlap      = max(0.0, overlapRight - overlapLeft);
  float coverage     = overlap / binWidth;

  float weightX = 0.0;
  if (coverage > 0.0) {
    float localX = (overlapLeft + overlapRight) * 0.5 / safeBrush.x;
    weightX = calculateEnvelopeGain(localX,
      envelopeDelayEndX, envelopeAttackEndX, envelopeSustainEndX, envelopeReleaseEndX
    ) * coverage;
  }

  // Y (pitch): use band center position relative to brush (unchanged)
  float localY = off.y / safeBrush.y;
  float weightY = calculateEnvelopeGain(localY,
    envelopeDelayEndY, envelopeAttackEndY, envelopeSustainEndY, envelopeReleaseEndY
  );

  return weightX * weightY;
}

bool isInsideBrush(vec2 unpackedUv) {
  vec2 offset = getEffectiveBrushOffset(unpackedUv);
  
  // With bottom-left reference, offset should be between 0 and brushSizeUv
  if ((brushSizeUv.x > 0.0 && (offset.x < 0.0 || offset.x >= brushSizeUv.x)) ||
      (brushSizeUv.y > 0.0 && (offset.y < 0.0 || offset.y >= brushSizeUv.y))) {
    return false;
  }
  return true;
}

// Applies the final brush effect, combining original and modified data.
// packedUv is the raw texture coordinate (vUv), destUv is the unpacked spectrogram coordinate
vec4 applyBrush(vec4 original, vec4 modified, float weight, vec2 destUv, vec2 packedUv) {
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
 
  float intensity = applyModulation(
    brushIntensity.value, brushIntensity.minValue, brushIntensity.maxValue,
    brushIntensity.modulationAmounts, brushIntensity.contextualModAmounts, destUv, 0, audioLevelDb
  );

  float pan = applyModulation(
    brushPan.value, brushPan.minValue, brushPan.maxValue,
    brushPan.modulationAmounts, brushPan.contextualModAmounts, destUv, 0, audioLevelDb
  );

  vec2 pannedModifiedL = fromPolar(getMag(modifiedL) * clamp(1.0 - pan, 0.0, 1.0), getPhase(modifiedL));
  vec2 pannedModifiedR = fromPolar(getMag(modifiedR) * clamp(1.0 + pan, 0.0, 1.0), getPhase(modifiedR));

  float effectiveWeight = weight * intensity;

  // Non-cumulative stroke: use the max weight seen at this pixel
  // Since we always blend from strokeStart, using max(current, stored) ensures:
  // - Gradual reveal as we paint (weight increases)
  // - No accumulation beyond intensity (mask caps the weight)
  // - Consistent result when re-painting same area (same blend from strokeStart)
  // Use packedUv to sample the mask since it's stored in packed format
  if (useStrokeMask) {
    float maskValue = texture(strokeMaskTex, packedUv).r;
    effectiveWeight = max(effectiveWeight, maskValue);
  }

  // Dissolve (stochastic)
  if (blendMode == 8) {
    vec2 finalL = (random(destUv.xy) < effectiveWeight) ? pannedModifiedL : originalL;
    vec2 finalR = (random(destUv.yx) < effectiveWeight) ? pannedModifiedR : originalR;
    finalL = limitMagnitude(finalL);
    finalR = limitMagnitude(finalR);
    return vec4(finalL, finalR);
  }

  float magModifiedL = getMag(pannedModifiedL);
  float magModifiedR = getMag(pannedModifiedR);

  // Use blendOriginal for blend formula calculations (prevents accumulation in non-cumulative mode)
  float magBlendOriginalL = getMag(blendOriginalL);
  float magBlendOriginalR = getMag(blendOriginalR);

  float averagePhaseL = 0.5 * (blendOriginalL.y + modifiedL.y);
  float averagePhaseR = 0.5 * (blendOriginalR.y + modifiedR.y);

  vec2 targetL, targetR;

  if      (blendMode == 0) { targetL = pannedModifiedL; targetR = pannedModifiedR; }
  else if (blendMode == 1) { targetL = fromPolar(magBlendOriginalL + magModifiedL, averagePhaseL);
                             targetR = fromPolar(magBlendOriginalR + magModifiedR, averagePhaseR); }
  else if (blendMode == 2) { targetL = fromPolar(magBlendOriginalL - magModifiedL, averagePhaseL);
                             targetR = fromPolar(magBlendOriginalR - magModifiedR, averagePhaseR); }
  else if (blendMode == 3) { targetL = fromPolar(magBlendOriginalL * magModifiedL * 4.0, averagePhaseL);
                             targetR = fromPolar(magBlendOriginalR * magModifiedR * 4.0, averagePhaseR); }
  else if (blendMode == 4) { targetL = fromPolar(magBlendOriginalL / (magModifiedL + EPSILON), averagePhaseL);
                             targetR = fromPolar(magBlendOriginalR / (magModifiedR + EPSILON), averagePhaseR); }
  else if (blendMode == 5) { targetL = (magModifiedL > magBlendOriginalL) ? modifiedL : blendOriginalL;
                             targetR = (magModifiedR > magBlendOriginalR) ? modifiedR : blendOriginalR; }
  else if (blendMode == 6) { targetL = (magModifiedL < magBlendOriginalL) ? modifiedL : blendOriginalL;
                             targetR = (magModifiedR < magBlendOriginalR) ? modifiedR : blendOriginalR; }
  else if (blendMode == 7) { targetL = fromPolar(abs(magBlendOriginalL - magModifiedL), averagePhaseL);
                             targetR = fromPolar(abs(magBlendOriginalR - magModifiedR), averagePhaseR); }
  else {                     targetL = blendOriginalL; targetR = blendOriginalR; }

  vec2 finalL, finalR;
  if (useLinearBlend) {
    finalL = mix(blendOriginalL, targetL, effectiveWeight);
    finalR = mix(blendOriginalR, targetR, effectiveWeight);
  } else {
    finalL = interpolateComplex(blendOriginalL, targetL, effectiveWeight);
    finalR = interpolateComplex(blendOriginalR, targetR, effectiveWeight);
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