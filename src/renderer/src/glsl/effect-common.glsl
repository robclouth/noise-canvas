// ============================================================================
// UNIFORMS & STRUCTS
// ============================================================================

#include "common.glsl"

uniform sampler2D sourceSpectrogramTex;
uniform sampler2D sourceMetadataTex;
uniform sampler2D sourceInverseMapTex;
uniform vec2 sourceSpectrogramTextureSize;
uniform float sourceFrameCount;
uniform float sourceBandCount;
uniform int sourceChannelCount;
uniform float sourceMinFreq;
uniform float sourceBandsPerOctave;
uniform float sourceSampleRate;

uniform sampler2D destSpectrogramTex;
uniform sampler2D destMetadataTex;
uniform sampler2D destInverseMapTex;
uniform vec2 destSpectrogramTextureSize;
uniform float destFrameCount;
uniform float destBandCount;
uniform int destChannelCount;
uniform float destSampleRate;
uniform float destMinFreq;
uniform float destBandsPerOctave;

uniform sampler2D originalSpectrogramTex;

uniform vec2 brushCenterUv;
uniform vec2 brushSizeUv;
uniform float viewZoomPower;
uniform float viewOffset;
uniform float featherX;
uniform float featherY;
uniform float featherSlopeTime;
uniform float featherSlopePitch;
uniform float sourceOffsetX;
uniform float sourceOffsetY;
uniform Parameter brushPan;
uniform Parameter brushIntensity;
uniform int blendMode;
uniform int wrapMode; // 0=Off, 1=Wrap X, 2=Wrap Y, 3=Wrap Both

// ============================================================================
// DEFINES & HELPERS
// ============================================================================

#include "modulation-common.glsl"; // Contains modulation and random functions

// Unwraps a phase angle to the range [-PI, PI].
float unwrapPhase(float phaseDelta) {
    return mod(phaseDelta + PI, 2.0 * PI) - PI;
}

vec2 unwrapPhase(vec2 phaseDelta) {
    return mod(phaseDelta + PI, 2.0 * PI) - PI;
}

// Wraps UV coordinates based on the wrap mode
vec2 wrapUv(vec2 uv) {
    vec2 wrapped = uv;
    
    // Wrap X if mode is 1 (Wrap X) or 3 (Wrap Both)
    if (wrapMode == 1 || wrapMode == 3) {
        wrapped.x = fract(uv.x);
    }
    
    // Wrap Y if mode is 2 (Wrap Y) or 3 (Wrap Both)
    if (wrapMode == 2 || wrapMode == 3) {
        wrapped.y = fract(uv.y);
    }
    
    return wrapped;
}


// ============================================================================
// COORDINATE UTILITIES
// ============================================================================
// Functions for converting between different coordinate systems:
// - Packed UV: The UV coordinates of the compressed texture we read from/write to.
// - Unpacked UV: The logical UV coordinates of the full spectrogram (time vs. frequency).
// - Screen UV: The UV coordinates of the visible portion on the screen.

// A struct to hold the coordinates for a processing operation.
struct ProcessingUvs {
    vec2 dest;   // The unpacked UV coordinate we are writing TO.
    vec2 source; // The unpacked UV coordinate we are sampling FROM.
};

// Converts a packed texture UV to an unpacked spectrogram UV.
vec2 packedToUnpackedUv(sampler2D inverseMapTex, vec2 packedUv, float frameCount, float bandCount) {
    vec2 unpackedPixelCoords = texture2D(inverseMapTex, packedUv).rg;
    float u = unpackedPixelCoords.x / frameCount;
    float v = 1.0 - (unpackedPixelCoords.y + 0.5) / bandCount;
    return vec2(u, v);
}

// Calculates the destination and source UVs for the current fragment shader invocation.
ProcessingUvs getProcessingUvs(vec2 destPackedUv) {
    ProcessingUvs uvs;
    uvs.dest = packedToUnpackedUv(destInverseMapTex, destPackedUv, destFrameCount, destBandCount);
    vec2 offsetUv = vec2(sourceOffsetX, sourceOffsetY);
    uvs.source = uvs.dest + offsetUv;
    return uvs;
}


// ============================================================================
// SPECTROGRAM SAMPLING
// ============================================================================
// This section deals with reading complex number data from the packed texture format.

/**
 * Core logic to read a single complex value pair (stereo) from a packed spectrogram
 * at a specific unpacked UV. This is a point sample with no interpolation.
 */
vec4 readPackedData(vec2 unpackedUv, sampler2D dataTex, sampler2D metaTex, vec2 packedTexSize, float frameCount, float bandCount) {
  // 1. Find the frequency band corresponding to the vertical UV coordinate.
  float bandIndex = floor((1.0 - unpackedUv.y) * bandCount);

  // 2. Look up metadata for this band (offset, length, time scaling).
  vec2 metaUv = vec2((bandIndex + 0.5) / bandCount, 0.5);
  vec3 meta = texture2D(metaTex, metaUv).rgb;
  float bandStartOffset = meta.r;
  float bandLength = meta.g;
  float bandTimeScaleExp = meta.b;

  // 3. Calculate the time index within this specific band.
  float timeInFrames = unpackedUv.x * frameCount;
  float scaledTime = timeInFrames / exp2(bandTimeScaleExp);
  float timeIndexInBand = floor(scaledTime);

  // 4. If out of bounds for this band, clamp to the edge.
  if (timeIndexInBand < 0.0 || timeIndexInBand >= bandLength) {
      timeIndexInBand = clamp(timeIndexInBand, 0.0, bandLength - 1.0);
  }

  // 5. Convert the 1D band index into a 2D packed texture coordinate.
  float linearPixelIndex = bandStartOffset + timeIndexInBand;
  float packedY = floor(linearPixelIndex / packedTexSize.x);
  float packedX = mod(linearPixelIndex, packedTexSize.x);
  vec2 packedUv = (vec2(packedX, packedY) + 0.5) / packedTexSize;

  // 6. Read the data.
  return texture2D(dataTex, packedUv);
}

// Helper for interpolating between two complex numbers (represented as vec2).
vec2 interpolateComplex(vec2 c1, vec2 c2, float amount) {
    float mag1 = length(c1);
    float phase1 = atan(c1.y, c1.x);
    float mag2 = length(c2);
    float phase2 = atan(c2.y, c2.x);

    float mag = mix(mag1, mag2, amount);
    float phaseDelta = unwrapPhase(phase2 - phase1);
    float phase = phase1 + amount * phaseDelta;

    return mag * vec2(cos(phase), sin(phase));
}

// Reads and linearly interpolates a complex value pair (stereo) from a packed spectrogram.
vec4 readPackedDataInterpolated(vec2 unpackedUv, sampler2D dataTex, sampler2D metaTex, vec2 packedTexSize, float frameCount, float bandCount) {
  float bandIndex = floor((1.0 - unpackedUv.y) * bandCount);
  vec2 metaUv = vec2((bandIndex + 0.5) / bandCount, 0.5);
  vec3 meta = texture2D(metaTex, metaUv).rgb;
  float bandStartOffset = meta.r;
  float bandLength = meta.g;
  float bandTimeScaleExp = meta.b;

  float timeInFrames = unpackedUv.x * frameCount;
  float scaledTime = timeInFrames / exp2(bandTimeScaleExp);
  float timeIndexFloor = floor(scaledTime);
  float timeFraction = fract(scaledTime);

  if (timeIndexFloor < 0.0 || timeIndexFloor + 1.0 >= bandLength) {
      return readPackedData(unpackedUv, dataTex, metaTex, packedTexSize, frameCount, bandCount);
  }

  float linearPixelIndex1 = bandStartOffset + timeIndexFloor;
  vec2 packedUv1 = (vec2(mod(linearPixelIndex1, packedTexSize.x), floor(linearPixelIndex1 / packedTexSize.x)) + 0.5) / packedTexSize;
  vec4 sample1 = texture2D(dataTex, packedUv1);

  float linearPixelIndex2 = bandStartOffset + timeIndexFloor + 1.0;
  vec2 packedUv2 = (vec2(mod(linearPixelIndex2, packedTexSize.x), floor(linearPixelIndex2 / packedTexSize.x)) + 0.5) / packedTexSize;
  vec4 sample2 = texture2D(dataTex, packedUv2);

  vec2 complexL = interpolateComplex(sample1.rg, sample2.rg, timeFraction);
  vec2 complexR = interpolateComplex(sample1.ba, sample2.ba, timeFraction);

  return vec4(complexL, complexR);
}

// --- Public Sampling API ---

/**
 * Samples from the source spectrogram at a precise point with NO interpolation.
 * This is faster but can sound less smooth for time-stretching.
 */
vec4 getSourceSamplePoint(vec2 sourceUv) {
    vec2 wrappedUv = wrapUv(sourceUv);
    return readPackedData(wrappedUv, sourceSpectrogramTex, sourceMetadataTex, sourceSpectrogramTextureSize, sourceFrameCount, sourceBandCount);
}

/**
 * Samples from the source spectrogram with linear interpolation in time.
 * This provides smoother results for time-stretching.
 */
vec4 getSourceSample(vec2 sourceUv) {
    vec2 wrappedUv = wrapUv(sourceUv);
    return readPackedDataInterpolated(wrappedUv, sourceSpectrogramTex, sourceMetadataTex, sourceSpectrogramTextureSize, sourceFrameCount, sourceBandCount);
}

/**
 * Samples from the original, unmodified destination spectrogram with interpolation.
 * Used for blending the brush effect against the initial state.
 */
vec4 getOriginalDestSample(vec2 destUv) {
    vec2 wrappedUv = wrapUv(destUv);
    return readPackedDataInterpolated(wrappedUv, originalSpectrogramTex, destMetadataTex, destSpectrogramTextureSize, destFrameCount, destBandCount);
}

// ============================================================================
// PHASE VOCODER TRANSFORMATION
// ============================================================================
/**
 * HIGH QUALITY (PITCH-AWARE): Performs true pitch-shifting and time-stretching.
 * This version correctly handles the non-uniform time/frequency grid of the
 * spectrogram, preventing both vertical drift and horizontal artifacts.
 * @param sourceUv The logical UV coordinate to sample FROM.
 * @param destUv The logical UV coordinate of the pixel we are writing TO.
 */
vec4 getTransformedSample(vec2 sourceUv, vec2 destUv) {
    // Apply wrapping to source UV
    vec2 wrappedSourceUv = wrapUv(sourceUv);
    
    // --- Frequency and Pitch Calculation ---
    float sourceFreq = sourceMinFreq * pow(2.0, (1.0 - wrappedSourceUv.y) * sourceBandCount / sourceBandsPerOctave);
    float destFreq = destMinFreq * pow(2.0, (1.0 - destUv.y) * destBandCount / destBandsPerOctave);
    float pitchRatio = (sourceFreq > 1e-5) ? destFreq / sourceFreq : 1.0;

    // --- Vertical (Frequency) Sampling Grid ---
    float bandNumFloat = (1.0 - wrappedSourceUv.y) * sourceBandCount - 0.5;
    float bandIndex = floor(bandNumFloat);
    float freqFraction = fract(bandNumFloat);

    if (bandIndex < 0.0 || bandIndex + 1.0 >= sourceBandCount) {
        return getSourceSample(wrappedSourceUv); // Fallback at top/bottom edges
    }

    // --- Get Metadata for BOTH Bands ---
    vec2 metaUv_base = vec2((bandIndex + 0.5) / sourceBandCount, 0.5);
    vec3 meta_base = texture2D(sourceMetadataTex, metaUv_base).rgb;
    float bandLength_base = meta_base.g;
    float bandTimeScaleExp_base = meta_base.b;

    vec2 metaUv_freq = vec2((bandIndex + 1.5) / sourceBandCount, 0.5);
    vec3 meta_freq = texture2D(sourceMetadataTex, metaUv_freq).rgb;
    float bandLength_freq = meta_freq.g;
    float bandTimeScaleExp_freq = meta_freq.b;

    // --- Horizontal (Time) Calculations for EACH Band INDEPENDENTLY ---
    float timeInFrames = wrappedSourceUv.x * sourceFrameCount;

    // Lower band time calculations
    float scaledTime_base = timeInFrames / exp2(bandTimeScaleExp_base);
    float timeIndex_base = floor(scaledTime_base);
    float timeFraction_base = fract(scaledTime_base);

    // Upper band time calculations
    float scaledTime_freq = timeInFrames / exp2(bandTimeScaleExp_freq);
    float timeIndex_freq = floor(scaledTime_freq);
    float timeFraction_freq = fract(scaledTime_freq);

    if (timeIndex_base + 1.0 >= bandLength_base || timeIndex_freq + 1.0 >= bandLength_freq) {
        return getSourceSample(wrappedSourceUv); // Fallback at time edges
    }

    // --- Gather Four Surrounding Data Points ---
    // Lower band samples
    float linearPixelIndex_base0 = meta_base.r + timeIndex_base;
    vec2 packedUv_base0 = (vec2(mod(linearPixelIndex_base0, sourceSpectrogramTextureSize.x), floor(linearPixelIndex_base0 / sourceSpectrogramTextureSize.x)) + 0.5) / sourceSpectrogramTextureSize;
    vec4 s_base = texture2D(sourceSpectrogramTex, packedUv_base0);

    float linearPixelIndex_base1 = meta_base.r + timeIndex_base + 1.0;
    vec2 packedUv_base1 = (vec2(mod(linearPixelIndex_base1, sourceSpectrogramTextureSize.x), floor(linearPixelIndex_base1 / sourceSpectrogramTextureSize.x)) + 0.5) / sourceSpectrogramTextureSize;
    vec4 s_time = texture2D(sourceSpectrogramTex, packedUv_base1);

    // Upper band samples
    float linearPixelIndex_freq0 = meta_freq.r + timeIndex_freq;
    vec2 packedUv_freq0 = (vec2(mod(linearPixelIndex_freq0, sourceSpectrogramTextureSize.x), floor(linearPixelIndex_freq0 / sourceSpectrogramTextureSize.x)) + 0.5) / sourceSpectrogramTextureSize;
    vec4 s_freq = texture2D(sourceSpectrogramTex, packedUv_freq0);

    float linearPixelIndex_freq1 = meta_freq.r + timeIndex_freq + 1.0;
    vec2 packedUv_freq1 = (vec2(mod(linearPixelIndex_freq1, sourceSpectrogramTextureSize.x), floor(linearPixelIndex_freq1 / sourceSpectrogramTextureSize.x)) + 0.5) / sourceSpectrogramTextureSize;
    vec4 s_time_freq = texture2D(sourceSpectrogramTex, packedUv_freq1);

    // --- Two-Stage Bilinear Interpolation ---
    // Stage 1: Horizontal (time) interpolation for each band separately.
    // We must apply the pitch correction to the phase difference before interpolating.

    // Lower band interpolation
    vec2 phase_base_L = vec2(atan(s_base.g, s_base.r), atan(s_time.g, s_time.r));
    vec2 phase_base_R = vec2(atan(s_base.a, s_base.b), atan(s_time.a, s_time.b));
    float correctedPhase_base_L = phase_base_L.x + unwrapPhase(phase_base_L.y - phase_base_L.x) * pitchRatio * timeFraction_base;
    float correctedPhase_base_R = phase_base_R.x + unwrapPhase(phase_base_R.y - phase_base_R.x) * pitchRatio * timeFraction_base;
    float mag_interp_base_L = mix(length(s_base.rg), length(s_time.rg), timeFraction_base);
    float mag_interp_base_R = mix(length(s_base.ba), length(s_time.ba), timeFraction_base);
    vec4 interp_base = vec4(mag_interp_base_L * cos(correctedPhase_base_L), mag_interp_base_L * sin(correctedPhase_base_L),
                            mag_interp_base_R * cos(correctedPhase_base_R), mag_interp_base_R * sin(correctedPhase_base_R));

    // Upper band interpolation
    vec2 phase_freq_L = vec2(atan(s_freq.g, s_freq.r), atan(s_time_freq.g, s_time_freq.r));
    vec2 phase_freq_R = vec2(atan(s_freq.a, s_freq.b), atan(s_time_freq.a, s_time_freq.b));
    float correctedPhase_freq_L = phase_freq_L.x + unwrapPhase(phase_freq_L.y - phase_freq_L.x) * pitchRatio * timeFraction_freq;
    float correctedPhase_freq_R = phase_freq_R.x + unwrapPhase(phase_freq_R.y - phase_freq_R.x) * pitchRatio * timeFraction_freq;
    float mag_interp_freq_L = mix(length(s_freq.rg), length(s_time_freq.rg), timeFraction_freq);
    float mag_interp_freq_R = mix(length(s_freq.ba), length(s_time_freq.ba), timeFraction_freq);
    vec4 interp_freq = vec4(mag_interp_freq_L * cos(correctedPhase_freq_L), mag_interp_freq_L * sin(correctedPhase_freq_L),
                            mag_interp_freq_R * cos(correctedPhase_freq_R), mag_interp_freq_R * sin(correctedPhase_freq_R));

    // Stage 2: Vertical (frequency) interpolation between the two results.
    vec2 final_L = interpolateComplex(interp_base.rg, interp_freq.rg, freqFraction);
    vec2 final_R = interpolateComplex(interp_base.ba, interp_freq.ba, freqFraction);

    return vec4(final_L, final_R);
}

// ============================================================================
// BRUSH & BLENDING LOGIC
// ============================================================================

// --- Complex Number & Polar Helpers ---
float getMag(vec2 c) { return length(c); }
float getPhase(vec2 c) { return atan(c.y, c.x); }
vec2 fromPolar(float mag, float phase) { return mag * vec2(cos(phase), sin(phase)); }

// Calculate wrapped distance between two points on an axis
float wrappedDistance(float a, float b, bool shouldWrap) {
    if (!shouldWrap) {
        return abs(a - b);
    }
    
    float dist = abs(a - b);
    float wrappedDist = 1.0 - dist;
    return min(dist, wrappedDist);
}

// Get the effective brush center considering wrapping
vec2 getEffectiveBrushOffset(vec2 unpackedUv) {
    vec2 offset = unpackedUv - brushCenterUv;
    
    // Handle X wrapping
    if (wrapMode == 1 || wrapMode == 3) {
        float dist = abs(offset.x);
        float wrappedDist = 1.0 - dist;
        if (wrappedDist < dist) {
            // Use wrapped distance
            offset.x = offset.x > 0.0 ? -(1.0 - offset.x) : (1.0 + offset.x);
        }
    }
    
    // Handle Y wrapping
    if (wrapMode == 2 || wrapMode == 3) {
        float dist = abs(offset.y);
        float wrappedDist = 1.0 - dist;
        if (wrappedDist < dist) {
            // Use wrapped distance
            offset.y = offset.y > 0.0 ? -(1.0 - offset.y) : (1.0 + offset.y);
        }
    }
    
    return offset;
}

// Determines the brush's influence at a given coordinate, including feathering.
float getBrushWeight(vec2 unpackedUv) {
    vec2 halfSize = brushSizeUv / 2.0;
    vec2 offset = getEffectiveBrushOffset(unpackedUv);
    vec2 localUv = (offset + halfSize) / brushSizeUv;
    vec2 slopeNormalized = (vec2(featherSlopeTime, featherSlopePitch) / 2.0 + 0.5);

    float weightX = 1.0;

    if (localUv.x < slopeNormalized.x) {
        weightX = smoothstep(0.0, slopeNormalized.x * featherX, localUv.x);
    } 
    else if (localUv.x > slopeNormalized.x ) {
        weightX = 1.0 - smoothstep(slopeNormalized.x * featherX + (1.0 - featherX), 1.0, localUv.x);
    } 

    float weightY = 1.0;

    if (localUv.y < slopeNormalized.y) {
        weightY = smoothstep(0.0, slopeNormalized.y * featherY, localUv.y);
    } 
    else if (localUv.y > slopeNormalized.y ) {
        weightY = 1.0 - smoothstep(slopeNormalized.y * featherY + (1.0 - featherY), 1.0, localUv.y);
    } 
    
    return weightX * weightY;
}

bool isInsideBrush(vec2 unpackedUv) {
    vec2 offset = getEffectiveBrushOffset(unpackedUv);
    vec2 diff = abs(offset);
    vec2 halfSize = brushSizeUv / 2.0;

    if ((brushSizeUv.x > 0.0 && diff.x >= halfSize.x) ||
        (brushSizeUv.y > 0.0 && diff.y >= halfSize.y)) {
        return false;
    }
    return true;
}

// Applies the final brush effect, combining original and modified data.
vec4 applyBrush(vec4 original, vec4 modified, float weight, vec2 destUv) {
    // --- 1. Initial Setup ---
    vec2 originalL = original.rg;
    vec2 originalR = original.ba;
    vec2 modifiedL = modified.rg;
    vec2 modifiedR = modified.ba;

    // Calculate modulation values
    float pan = applyModulation(brushPan.value, brushPan.minValue, brushPan.maxValue, brushPan.modulationAmounts, destUv, 0);
    float intensity = applyModulation(brushIntensity.value, brushIntensity.minValue, brushIntensity.maxValue, brushIntensity.modulationAmounts, destUv, 0);

    // Apply panning to the modified signal by scaling its magnitude.
    // A simple component-wise multiplication works because scaling a complex number (a, b)
    // by a real k results in (ka, kb), which corresponds to scaling its magnitude by k
    // while keeping the phase unchanged.
    vec2 pannedModifiedL = modifiedL * clamp(1.0 - pan, 0.0, 1.0);
    vec2 pannedModifiedR = modifiedR * clamp(1.0 + pan, 0.0, 1.0);

    // Calculate final brush weight
    float effectiveWeight = weight * intensity;


    // --- 2. Handle Special "Dissolve" Mode ---
    // This mode doesn't blend, it replaces pixels randomly.
    if (blendMode == 8) {
        vec2 finalL = (random(destUv.xy) < effectiveWeight) ? pannedModifiedL : originalL;
        vec2 finalR = (random(destUv.yx) < effectiveWeight) ? pannedModifiedR : originalR;
        return vec4(finalL, finalR);
    }

    // --- 3. Calculate the "Target" Value for Blending ---
    // For all other modes, we first determine the 100% blended result ("target"),
    // and then interpolate towards it based on the effective weight.
    float magOriginalL = getMag(originalL);
    float magModifiedL = getMag(pannedModifiedL); // Use panned magnitude
    float phaseOriginalL = getPhase(originalL);

    float magOriginalR = getMag(originalR);
    float magModifiedR = getMag(pannedModifiedR); // Use panned magnitude
    float phaseOriginalR = getPhase(originalR);

    vec2 finalL = originalL;
    vec2 finalR = originalR;

    if (blendMode == 0) { // Mix
        finalL = interpolateComplex(originalL, pannedModifiedL, effectiveWeight);
        finalR = interpolateComplex(originalR, pannedModifiedR, effectiveWeight);
    } else if (blendMode == 1) { // Add
        finalL = fromPolar(magOriginalL + magModifiedL * effectiveWeight, phaseOriginalL);
        finalR = fromPolar(magOriginalR + magModifiedR * effectiveWeight, phaseOriginalR);
    } else if (blendMode == 2) { // Subtract
        finalL = fromPolar(max(0.0, magOriginalL - magModifiedL * effectiveWeight), phaseOriginalL);
        finalR = fromPolar(max(0.0, magOriginalR - magModifiedR * effectiveWeight), phaseOriginalR);
    } else if (blendMode == 3) { // Multiply
        finalL = fromPolar(magOriginalL * mix(1.0, magModifiedL, effectiveWeight), phaseOriginalL);
        finalR = fromPolar(magOriginalR * mix(1.0, magModifiedR, effectiveWeight), phaseOriginalR);
    } else if (blendMode == 4) { // Divide
        float divisorL = mix(1.0, magModifiedL, effectiveWeight);
        float divisorR = mix(1.0, magModifiedR, effectiveWeight);
        finalL = fromPolar(magOriginalL / max(1e-6, divisorL), phaseOriginalL);
        finalR = fromPolar(magOriginalR / max(1e-6, divisorR), phaseOriginalR);
    } else {
        // --- Fallback to interpolation for other modes ---
        vec2 targetL, targetR;

        if (blendMode == 5) {
            // Choose the complex number with the greater magnitude
            targetL = (magModifiedL > magOriginalL) ? pannedModifiedL : originalL;
            targetR = (magModifiedR > magOriginalR) ? pannedModifiedR : originalR;
        } else if (blendMode == 6) {
            // Choose the complex number with the lesser magnitude
            targetL = (magModifiedL < magOriginalL) ? pannedModifiedL : originalL;
            targetR = (magModifiedR < magOriginalR) ? pannedModifiedR : originalR;
        } else if (blendMode == 7) {
            // Take the absolute difference of magnitudes, keep original phase
            targetL = fromPolar(abs(magOriginalL - magModifiedL), phaseOriginalL);
            targetR = fromPolar(abs(magOriginalR - magModifiedR), phaseOriginalR);
        } else {
            // Default case: do nothing
            targetL = originalL;
            targetR = originalR;
        }

        finalL = interpolateComplex(originalL, targetL, effectiveWeight);
        finalR = interpolateComplex(originalR, targetR, effectiveWeight);
    }

    return vec4(finalL, finalR);
}