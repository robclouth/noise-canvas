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
uniform int algorithm;

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

  // 4. If out of bounds for this band, clamp to the
  if (timeIndexInBand < 0.0 || timeIndexInBand >= bandLength) {
      timeIndexInBand = clamp(timeIndexInBand, 0.0, bandLength - 1.0);
  }

  // 5. Convert the 1D band index into a 2D packed texture coordinate.
  float linearPixelIndex = bandStartOffset + timeIndexInBand;
  float packedY = floor(linearPixelIndex / packedTexSize.x);
  float packedX = mod(linearPixelIndex, packedTexSize.x);
  vec2 packedUv = (vec2(packedX, packedY) + 0.5) / packedTexSize;

  // 6. Read the data.
  vec4 result = texture2D(dataTex, packedUv);

  return result;
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


// Helper for interpolating between two complex numbers (represented as vec2).
vec2 interpolateComplex(vec2 c1, vec2 c2, float amount) {
    float mag1 = getMag(c1);
    float mag2 = getMag(c2);
    float magMix = exp(mix(log(mag1), log(mag2), amount));

    float phase1 = getPhase(c1);
    float phase2 = getPhase(c2);

    float phaseDelta = unwrapPhase(phase2 - phase1);
    float phase = phase1 + amount * phaseDelta;

    return fromPolar(magMix, phase);
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


/**
 * Samples from the source spectrogram with linear interpolation in time.
 * This provides smoother results for time-stretching.
 */
vec4 getSourceSample(vec2 sourceUv) {
    vec2 wrappedUv = wrapUv(sourceUv);
    return readPackedDataInterpolated(wrappedUv, sourceSpectrogramTex, sourceMetadataTex, sourceSpectrogramTextureSize, sourceFrameCount, sourceBandCount);
}

/**
 * Calculate audio level in dB from the spectrogram at a given position.
 * Used by envelope follower modulation to react to audio amplitude.
 */
float getAudioLevelDb(vec2 uv) {
    // Sample the source spectrogram
    vec4 sourceTexel = getSourceSample(uv);
    
    // Extract complex values for left and right channels
    vec2 complexL = sourceTexel.rg; // Left channel (real, imaginary)
    vec2 complexR = sourceTexel.ba; // Right channel (real, imaginary)
    
    // Calculate magnitude for each channel
    float magnitudeL = length(complexL);
    float magnitudeR = length(complexR);
    
    // Average the two channels
    float avgMagnitude = (magnitudeL + magnitudeR) * 0.5;
    
    // Avoid log(0) by clamping to a small value
    avgMagnitude = max(avgMagnitude, 0.000001);
    
    // Convert to dB: 20 * log10(magnitude)
    float levelDb = 20.0 * log(avgMagnitude) / log(10.0);
    
    return levelDb;
}

/**
 * Samples from the original, unmodified destination spectrogram with interpolation.
 * Used for blending the brush effect against the initial state.
 */
vec4 getOriginalDestSample(vec2 destUv) {
    vec2 wrappedUv = wrapUv(destUv);
    return readPackedDataInterpolated(wrappedUv, originalSpectrogramTex, destMetadataTex, destSpectrogramTextureSize, destFrameCount, destBandCount);
}

vec2 modifyPhase(vec2 complex, vec2 uv, bool shouldRandomise) {
    float mag = getMag(complex);
    float phase = getPhase(complex);

    if(shouldRandomise) {
        vec2 seed1 = uv;
        vec2 seed2 = uv + vec2(12.34, 56.78);
        phase = random(seed1 + random(seed2)) * TWO_PI;
        return fromPolar(mag, phase);
    }

    return fromPolar(mag, phase);
}


vec4 getTransformedSampleBasic(vec2 sourceUv, bool shouldRandomisePhase, vec2 destUv) {
    float bandIndex = floor((1.0 - sourceUv.y) * sourceBandCount);

    // Get band metadata
    vec2 metaUv = vec2((bandIndex + 0.5) / sourceBandCount, 0.5);
    vec4 meta = texture2D(sourceMetadataTex, metaUv);
    float bandStartOffset = meta.r;
    float bandLength = meta.g;
    float bandTimeScaleExp = meta.b;

    float timeInFrames = sourceUv.x * sourceFrameCount;
    float scaledTime = timeInFrames / exp2(bandTimeScaleExp);
    float timeIndexFloor = floor(scaledTime);
    float timeFraction = fract(scaledTime);

    // Get the value at the integer time before the continuous time 
    float linearPixelIndex1 = bandStartOffset + timeIndexFloor;
    vec2 packedUv1 = (vec2(mod(linearPixelIndex1, sourceSpectrogramTextureSize.x), floor(linearPixelIndex1 / sourceSpectrogramTextureSize.x)) + 0.5) / sourceSpectrogramTextureSize;
    vec4 sample0 = texture2D(sourceSpectrogramTex, packedUv1);

    // Get the value at the integer time after the continuous time
    float linearPixelIndex2 = bandStartOffset + timeIndexFloor + 1.0;
    vec2 packedUv2 = (vec2(mod(linearPixelIndex2, sourceSpectrogramTextureSize.x), floor(linearPixelIndex2 / sourceSpectrogramTextureSize.x)) + 0.5) / sourceSpectrogramTextureSize;
    vec4 sample1 = texture2D(sourceSpectrogramTex, packedUv2);
    
    // Extract complex values
    vec2 complex0L = sample0.rg;
    vec2 complex1L = sample1.rg;
    vec2 complex0R = sample0.ba;
    vec2 complex1R = sample1.ba;

    // Interpolate using complex interpolation
    vec2 correctedL = interpolateComplex(complex0L, complex1L, timeFraction);
    vec2 correctedR = interpolateComplex(complex0R, complex1R, timeFraction);

    correctedL = modifyPhase(correctedL, packedUv1, shouldRandomisePhase);
    correctedR = modifyPhase(correctedR, packedUv1, shouldRandomisePhase);

    return vec4(correctedL, correctedR);
}

vec4 getTransformedSampleSnappy(vec2 sourceUv, bool shouldRandomisePhase, vec2 destUv) {
    vec4 original = getSourceSamplePoint(destUv);
    float originalPhaseL = getPhase(original.rg);
    float originalPhaseR = getPhase(original.ba);

    float bandIndex = floor((1.0 - sourceUv.y) * sourceBandCount);

    // Get band metadata
    vec2 metaUv = vec2((bandIndex + 0.5) / sourceBandCount, 0.5);
    vec4 meta = texture2D(sourceMetadataTex, metaUv);
    float bandStartOffset = meta.r;
    float bandLength = meta.g;
    float bandTimeScaleExp = meta.b;

    float timeInFrames = sourceUv.x * sourceFrameCount;
    float scaledTime = timeInFrames / exp2(bandTimeScaleExp);
    float timeIndexFloor = floor(scaledTime);
    float timeFraction = fract(scaledTime);

    // Get the value at the integer time before the continuous time 
    float linearPixelIndex1 = bandStartOffset + timeIndexFloor;
    vec2 packedUv1 = (vec2(mod(linearPixelIndex1, sourceSpectrogramTextureSize.x), floor(linearPixelIndex1 / sourceSpectrogramTextureSize.x)) + 0.5) / sourceSpectrogramTextureSize;
    vec4 sample0 = texture2D(sourceSpectrogramTex, packedUv1);

    // Get the value at the integer time after the continuous time
    float linearPixelIndex2 = bandStartOffset + timeIndexFloor + 1.0;
    vec2 packedUv2 = (vec2(mod(linearPixelIndex2, sourceSpectrogramTextureSize.x), floor(linearPixelIndex2 / sourceSpectrogramTextureSize.x)) + 0.5) / sourceSpectrogramTextureSize;
    vec4 sample1 = texture2D(sourceSpectrogramTex, packedUv2);
    
    // Extract complex values
    vec2 complex0L = sample0.rg;
    vec2 complex1L = sample1.rg;
    vec2 complex0R = sample0.ba;
    vec2 complex1R = sample1.ba;

    float magL = mix(getMag(complex0L), getMag(complex1L), timeFraction);
    float magR = mix(getMag(complex0R), getMag(complex1R), timeFraction);
    float phaseL = unwrapPhase(getPhase(complex1L) - getPhase(complex0L)) + originalPhaseL;
    float phaseR = unwrapPhase(getPhase(complex1R) - getPhase(complex0R)) + originalPhaseR;

    vec2 correctedL = fromPolar(magL, phaseL);
    vec2 correctedR = fromPolar(magR, phaseR);

    return vec4(correctedL, correctedR);
}



vec4 getTransformedSample(vec2 sourceUv, vec2 destUv) {
    vec2 wrappedSourceUv = wrapUv(sourceUv);

    if (algorithm == 0) {
        return getTransformedSampleBasic(wrappedSourceUv, false, destUv);
    } else if (algorithm == 1) {
        return getTransformedSampleBasic(wrappedSourceUv, true, destUv);
    } else if (algorithm == 2) {
        return getTransformedSampleSnappy(wrappedSourceUv, true, destUv);
    }
    return vec4(0.0);
}

// ============================================================================
// BRUSH & BLENDING LOGIC
// ============================================================================



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

    // Calculate audio level for envelope follower modulation
    float audioLevelDb = getAudioLevelDb(destUv);

    // Calculate modulation values
    float pan = applyModulation(brushPan.value, brushPan.minValue, brushPan.maxValue, brushPan.modulationAmounts, destUv, 0, audioLevelDb);
    float intensity = applyModulation(brushIntensity.value, brushIntensity.minValue, brushIntensity.maxValue, brushIntensity.modulationAmounts, destUv, 0, audioLevelDb);

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