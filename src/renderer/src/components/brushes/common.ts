import { Texture, Vector2 } from "three";

export const vertexShader = /*glsl*/ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

export const modulatorCode = /* glsl */ `
float random(vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
}

float getModulation(vec2 uv) {
  float v = 0.0;
  if (modulatorMode == 0) { // LFO
    vec2 rates = vec2(1.0 / modulatorPatternRateBeats, 1.0 / modulatorPatternRateSemis);
    vec2 cartesianPos = uv * rates;
    vec2 centeredUv = uv - 0.5;
    float dist = length(centeredUv * 2.0);
    float radialRate = 1.0 / modulatorPatternRateBeats;

    if (modulatorPatternShape == 0) { // SINE
      if (modulatorPatternRadial) {
        v = sin(dist * radialRate * PI);
      } else {
        v = (sin(cartesianPos.x * 2.0 * PI) + sin(cartesianPos.y * 2.0 * PI));
      }
    } else if (modulatorPatternShape == 1) { // TRIANGLE
      if (modulatorPatternRadial) {
        float p = fract(dist * radialRate);
        v = (1.0 - abs(p * 2.0 - 1.0)) * 2.0 - 1.0;
      } else {
        vec2 p = fract(cartesianPos);
        float tx = 1.0 - abs(p.x * 2.0 - 1.0);
        float ty = 1.0 - abs(p.y * 2.0 - 1.0);
        v = (tx * ty) * 2.0 - 1.0;
      }
    } else if (modulatorPatternShape == 2) { // SQUARE
      if (modulatorPatternRadial) {
        float p = fract(dist * radialRate);
        v = step(0.5, p) * 2.0 - 1.0;
      } else {
        vec2 p = fract(cartesianPos);
        v = (pow(step(0.5, p.x) - step(0.5, p.y), 2.0)) * 2.0 - 1.0;
      }
    } else if (modulatorPatternShape == 3) { // SAWTOOTH
      if (modulatorPatternRadial) {
        v = fract(dist * radialRate) * 2.0 - 1.0;
      } else {
        vec2 p = fract(cartesianPos);
        v = (p.x * p.y) * 2.0 - 1.0;
      }
    } else if (modulatorPatternShape == 4) { // PULSE
      if (modulatorPatternRadial) {
        v = (1.0 - step(0.2, fract(dist * radialRate))) * 2.0 - 1.0;
      } else {
        vec2 p = fract(cartesianPos);
        v = (max(1.0 - step(0.2, p.x), 1.0 - step(0.2, p.y))) * 2.0 - 1.0;
      }
    } else if (modulatorPatternShape == 5) { // RANDOM
      if (modulatorPatternRadial) {
        float d = floor(dist * radialRate);
        v = random(vec2(d, d)) * 2.0 - 1.0;
      } else {
        v = random(floor(cartesianPos)) * 2.0 - 1.0;
      }
    }
  }
  return v;
}

float applyModulation(float value, float modulationAmount, vec2 uv) {
  float modulation = getModulation(uv);
  return value + modulation * modulationAmount;
}
`;

export const common = /* glsl */ `
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


// Brush & View Uniforms
uniform vec2 brushCenterUv;
uniform vec2 brushSizeUv;
uniform float viewZoomPower;
uniform float viewOffset;
uniform float featherX;
uniform float featherY;
uniform vec2 offsetUv;
uniform float pan;
uniform float brushIntensity;
uniform float brushIntensityMod;
uniform int blendMode; // 0: Normal, 1: Maximum, 2: Minimum

uniform int modulatorMode;
uniform int modulatorPatternShape;
uniform float modulatorPatternRateBeats;
uniform float modulatorPatternRateSemis;
uniform bool modulatorPatternRadial;

#define PI 3.141592653589793

${modulatorCode}

//------------------------------------------------------------------------------
// Coordinate System & Helpers
//------------------------------------------------------------------------------
struct Coords {
    vec2 dest;
    vec2 source;
};


vec2 screenToZoomed(vec2 screenUv) {
  float zoom = pow(2.0, viewZoomPower);
  if (zoom <= 1.0) { return screenUv; }
  float viewWidth = 1.0 / zoom;
  float viewStartX = viewOffset * (1.0 - viewWidth);
  return vec2(viewStartX + screenUv.x * viewWidth, screenUv.y);
}

vec2 zoomedToScreen(vec2 zoomedUv) {
    float zoom = pow(2.0, viewZoomPower);
    if (zoom <= 1.0) { return zoomedUv; }
    float viewWidth = 1.0 / zoom;
    float viewStartX = viewOffset * (1.0 - viewWidth);
    return vec2((zoomedUv.x - viewStartX) / viewWidth, zoomedUv.y);
}

vec2 getUnpackedUvFromPackedUv(vec2 packedUv) {
    vec2 rawUnpacked = texture2D(sourceInverseMapTex, packedUv).rg;
    vec2 unpackedUv;
    unpackedUv.x = rawUnpacked.x / sourceFrameCount;
    unpackedUv.y = 1.0 - (rawUnpacked.y + 0.5) / sourceBandCount;
    return unpackedUv;
}

vec2 getUnpackedUvFromPackedUvDest(vec2 packedUv) {
    vec2 rawUnpacked = texture2D(destInverseMapTex, packedUv).rg;
    vec2 unpackedUv;
    unpackedUv.x = rawUnpacked.x / destFrameCount;
    unpackedUv.y = 1.0 - (rawUnpacked.y + 0.5) / destBandCount;
    return unpackedUv;
}

Coords getCoords(vec2 packedUv) {
    Coords c;
    c.dest = getUnpackedUvFromPackedUvDest(packedUv);
    c.source = c.dest + offsetUv;
    return c;
}

vec4 applyBrushEffect(vec4 original, vec4 modified, float weight, Coords coords) {
    vec2 originalL = original.rg;
    vec2 originalR = original.ba;
    vec2 modifiedL = modified.rg;
    vec2 modifiedR = modified.ba;
    vec2 finalL;
    vec2 finalR;

    float brushIntensityMod = applyModulation(brushIntensity, brushIntensityMod, coords.dest);

    float leftWeight = clamp(1.0 - pan, 0.0, 1.0);
    float rightWeight = clamp(1.0 + pan, 0.0, 1.0);
    float effectiveWeightL = weight * brushIntensityMod * leftWeight;
    float effectiveWeightR = weight * brushIntensityMod * rightWeight;

    if (blendMode == 3) { // Dissolve
        if (random(originalL + modifiedL) < effectiveWeightL) {
            finalL = modifiedL;
        } else {
            finalL = originalL;
        }
        if (random(originalR + modifiedR + vec2(0.1, -0.1)) < effectiveWeightR) {
            finalR = modifiedR;
        } else {
            finalR = originalR;
        }
        return vec4(finalL, finalR);
    }

    vec2 blendedL, blendedR;

    if (blendMode == 1) { // Maximum
        blendedL = length(modifiedL) > length(originalL) ? modifiedL : originalL;
        blendedR = length(modifiedR) > length(originalR) ? modifiedR : originalR;
    } else if (blendMode == 2) { // Minimum
        blendedL = length(modifiedL) < length(originalL) ? modifiedL : originalL;
        blendedR = length(modifiedR) < length(originalR) ? modifiedR : originalR;
    } else if (blendMode == 4) { // Multiply
        float magL = length(originalL) * length(modifiedL);
        blendedL = (length(originalL) > 1e-6) ? magL * normalize(originalL) : vec2(0.0);
        float magR = length(originalR) * length(modifiedR);
        blendedR = (length(originalR) > 1e-6) ? magR * normalize(originalR) : vec2(0.0);
    } else if (blendMode == 5) { // Difference
        float magL = abs(length(originalL) - length(modifiedL));
        blendedL = (length(originalL) > 1e-6) ? magL * normalize(originalL) : vec2(0.0);
        float magR = abs(length(originalR) - length(modifiedR));
        blendedR = (length(originalR) > 1e-6) ? magR * normalize(originalR) : vec2(0.0);
    } else if (blendMode == 6) { // Subtract
        float magL = max(length(originalL) - length(modifiedL), 0.0);
        blendedL = (length(originalL) > 1e-6) ? magL * normalize(originalL) : vec2(0.0);
        float magR = max(length(originalR) - length(modifiedR), 0.0);
        blendedR = (length(originalR) > 1e-6) ? magR * normalize(originalR) : vec2(0.0);
    } else if (blendMode == 7) { // Divide
        float magL = length(originalL) / (length(modifiedL) + 1e-6);
        blendedL = (length(originalL) > 1e-6) ? magL * normalize(originalL) : vec2(0.0);
        float magR = length(originalR) / (length(modifiedR) + 1e-6);
        blendedR = (length(originalR) > 1e-6) ? magR * normalize(originalR) : vec2(0.0);
    } else { // Normal (blendMode == 0)
        blendedL = modifiedL;
        blendedR = modifiedR;
    }

    finalL = mix(originalL, blendedL, effectiveWeightL);
    finalR = mix(originalR, blendedR, effectiveWeightR);

    return vec4(finalL, finalR);
}

bool isInBrush(vec2 logicalUv) {
    vec2 diff = abs(logicalUv - brushCenterUv);
    bool inX = brushSizeUv.x == 0.0 || diff.x < brushSizeUv.x / 2.0;
    bool inY = brushSizeUv.y == 0.0 || diff.y < brushSizeUv.y / 2.0;
    return inX && inY;
}

float getFeatherWeight(vec2 logicalUv) {
    if (!isInBrush(logicalUv)) { return 0.0; }
    vec2 diff = abs(logicalUv - brushCenterUv);
    
    float weightX = 1.0;
    if (brushSizeUv.x > 0.0) {
        float featherZoneX = 0.5 * featherX;
        weightX = smoothstep(0.5, 0.5 - featherZoneX, diff.x / brushSizeUv.x);
    }

    float weightY = 1.0;
    if (brushSizeUv.y > 0.0) {
        float featherZoneY = 0.5 * featherY;
        weightY = smoothstep(0.5, 0.5 - featherZoneY, diff.y / brushSizeUv.y);
    }
    return weightX * weightY;
}

float unwrapPhase(float phaseDelta) {
    return mod(phaseDelta + PI, 2.0 * PI) - PI;
}

vec2 unwrapPhase(vec2 phaseDelta) {
    return mod(phaseDelta + PI, 2.0 * PI) - PI;
}

/**
 * Converts a vertical logical UV coordinate to its corresponding frequency in Hz.
 */
float uvToHz(float v) {
    float totalOctaves = sourceBandCount / sourceBandsPerOctave;
    float octave = (1.0 - v) * totalOctaves;
    return sourceMinFreq * pow(2.0, octave);
}

/**
 * Converts a frequency in Hz to its corresponding vertical logical UV coordinate.
 */
float hzToUv(float hz) {
    if (hz < sourceMinFreq) return 1.0;
    float octave = log2(hz / sourceMinFreq);
    float totalOctaves = sourceBandCount / sourceBandsPerOctave;
    return 1.0 - (octave / totalOctaves);
}

//------------------------------------------------------------------------------
// Core Sampling Logic (Final Version)
//------------------------------------------------------------------------------

vec4 _sampleSpectrogramPoint(vec2 logicalUv, sampler2D data, sampler2D meta, vec2 texSize, float nFrames, float nBands, float sRate) {
  float bandIndex = floor((1.0 - logicalUv.y) * nBands);
  vec2 metaUv = vec2((bandIndex + 0.5) / nBands, 0.5);
  vec3 metaData = texture2D(meta, metaUv).rgb;
  float bandOffset = metaData.r;
  float bandLength = metaData.g;
  float bandScaleExp = metaData.b;
  float timeSample = logicalUv.x * nFrames;
  float timeInBand = timeSample / exp2(bandScaleExp);
  float coefIndexInBand = floor(timeInBand);
  if (coefIndexInBand < 0.0 || coefIndexInBand >= bandLength) { return vec4(0.0); }
  float linearPixelIndex = bandOffset + coefIndexInBand;
  float packedY = floor(linearPixelIndex / texSize.x);
  float packedX = mod(linearPixelIndex, texSize.x);
  vec2 packedUv = (vec2(packedX, packedY) + 0.5) / texSize;
  return texture2D(data, packedUv);
}

vec4 _sampleSpectrogramPointInterpolated(vec2 logicalUv, sampler2D data, sampler2D meta, vec2 texSize, float nFrames, float nBands, float sRate) {
  float bandIndex = floor((1.0 - logicalUv.y) * nBands);
  vec2 metaUv = vec2((bandIndex + 0.5) / nBands, 0.5);
  vec3 metaData = texture2D(meta, metaUv).rgb;
  float bandOffset = metaData.r;
  float bandLength = metaData.g;
  float bandScaleExp = metaData.b;
  float timeSample = logicalUv.x * nFrames;
  float timeInBand = timeSample / exp2(bandScaleExp);

  float coefIndexInBandBase = floor(timeInBand);
  float xFrac = fract(timeInBand);

  if (coefIndexInBandBase < 0.0 || coefIndexInBandBase + 1.0 >= bandLength) {
    if (coefIndexInBandBase < 0.0 || coefIndexInBandBase >= bandLength) return vec4(0.0);
    float linearPixelIndex = bandOffset + coefIndexInBandBase;
    float packedY = floor(linearPixelIndex / texSize.x);
    float packedX = mod(linearPixelIndex, texSize.x);
    vec2 packedUv = (vec2(packedX, packedY) + 0.5) / texSize;
    return texture2D(data, packedUv);
  }

  float linearPixelIndex1 = bandOffset + coefIndexInBandBase;
  float packedY1 = floor(linearPixelIndex1 / texSize.x);
  float packedX1 = mod(linearPixelIndex1, texSize.x);
  vec2 packedUv1 = (vec2(packedX1, packedY1) + 0.5) / texSize;
  vec4 s1 = texture2D(data, packedUv1);

  float linearPixelIndex2 = bandOffset + coefIndexInBandBase + 1.0;
  float packedY2 = floor(linearPixelIndex2 / texSize.x);
  float packedX2 = mod(linearPixelIndex2, texSize.x);
  vec2 packedUv2 = (vec2(packedX2, packedY2) + 0.5) / texSize;
  vec4 s2 = texture2D(data, packedUv2);

  // Left channel
  float mag1_L = length(s1.rg);
  float phase1_L = atan(s1.g, s1.r);
  float mag2_L = length(s2.rg);
  float phase2_L = atan(s2.g, s2.r);
  float mag_L = mix(mag1_L, mag2_L, xFrac);
  float phase_delta_L = unwrapPhase(phase2_L - phase1_L);
  float phase_L = phase1_L + xFrac * phase_delta_L;
  vec2 c_L = mag_L * vec2(cos(phase_L), sin(phase_L));

  // Right channel
  float mag1_R = length(s1.ba);
  float phase1_R = atan(s1.a, s1.b);
  float mag2_R = length(s2.ba);
  float phase2_R = atan(s2.a, s2.b);
  float mag_R = mix(mag1_R, mag2_R, xFrac);
  float phase_delta_R = unwrapPhase(phase2_R - phase1_R);
  float phase_R = phase1_R + xFrac * phase_delta_R;
  vec2 c_R = mag_R * vec2(cos(phase_R), sin(phase_R));

  return vec4(c_L, c_R);
}

vec4 sampleSpectrogramPoint(vec2 logicalUv) {
    return _sampleSpectrogramPoint(logicalUv, sourceSpectrogramTex, sourceMetadataTex, sourceSpectrogramTextureSize, sourceFrameCount, sourceBandCount, sourceSampleRate);
}

vec4 sampleSpectrogramPointInterpolated(vec2 logicalUv) {
    return _sampleSpectrogramPointInterpolated(logicalUv, sourceSpectrogramTex, sourceMetadataTex, sourceSpectrogramTextureSize, sourceFrameCount, sourceBandCount, sourceSampleRate);
}

vec4 sampleFromSource(vec2 logicalUv) {
    return sampleSpectrogramPointInterpolated(logicalUv);
}

vec4 sampleFromOriginal(vec2 logicalUv) {
    return _sampleSpectrogramPointInterpolated(logicalUv, originalSpectrogramTex, destMetadataTex, destSpectrogramTextureSize, destFrameCount, destBandCount, destSampleRate);
}


vec4 _performTransformation(vec2 sourceUv, vec2 targetUv,
                           float srcNBands, float srcBPerOctave, float srcMFreq, float srcNFrames,
                           sampler2D srcMeta, sampler2D srcData, vec2 srcTexSize, float srcSRate,
                           float dstNBands, float dstBPerOctave, float dstMFreq) {
    float sourceFreq = srcMFreq * pow(2.0, (1.0 - sourceUv.y) * srcNBands / srcBPerOctave);
    float targetFreq = dstMFreq * pow(2.0, (1.0 - targetUv.y) * dstNBands / dstBPerOctave);
    float pitchRatio = (sourceFreq > 1.0e-5) ? targetFreq / sourceFreq : 1.0;

    float bandNumFloat = (1.0 - sourceUv.y) * srcNBands;
    float bandIndexBase = floor(bandNumFloat);
    float yFrac = fract(bandNumFloat);

    vec2 metaUvBase = vec2((bandIndexBase + 0.5) / srcNBands, 0.5);
    vec3 metaBase = texture2D(srcMeta, metaUvBase).rgb;
    float bandScaleExpBase = metaBase.b;

    float timeSample = sourceUv.x * srcNFrames;
    float timeInBand = timeSample / exp2(bandScaleExpBase);
    float coefIndexInBandBase = floor(timeInBand);
    float xFrac = fract(timeInBand);

    float localTimeStepUv = exp2(bandScaleExpBase) / srcNFrames;

    vec2 uvBase;
    uvBase.x = (coefIndexInBandBase * exp2(bandScaleExpBase)) / srcNFrames;
    uvBase.y = 1.0 - (bandIndexBase + 0.5) / srcNBands;
    vec2 uvT = uvBase + vec2(localTimeStepUv, 0.0);
    vec2 uvF = uvBase;
    uvF.y = 1.0 - (bandIndexBase + 1.0 + 0.5) / srcNBands;
    vec2 uvTf = uvF + vec2(localTimeStepUv, 0.0);

    vec4 dataBase = _sampleSpectrogramPoint(uvBase, srcData, srcMeta, srcTexSize, srcNFrames, srcNBands, srcSRate);
    vec4 dataT = _sampleSpectrogramPoint(uvT, srcData, srcMeta, srcTexSize, srcNFrames, srcNBands, srcSRate);
    vec4 dataF = _sampleSpectrogramPoint(uvF, srcData, srcMeta, srcTexSize, srcNFrames, srcNBands, srcSRate);
    vec4 dataTf = _sampleSpectrogramPoint(uvTf, srcData, srcMeta, srcTexSize, srcNFrames, srcNBands, srcSRate);

    vec2 magBase = vec2(length(dataBase.rg), length(dataBase.ba));
    vec2 magT = vec2(length(dataT.rg), length(dataT.ba));
    vec2 magF = vec2(length(dataF.rg), length(dataF.ba));
    vec2 magTf = vec2(length(dataTf.rg), length(dataTf.ba));

    vec2 phaseBase = vec2(atan(dataBase.g, dataBase.r), atan(dataBase.a, dataBase.b));
    vec2 phaseT = vec2(atan(dataT.g, dataT.r), atan(dataT.a, dataT.b));
    vec2 phaseF = vec2(atan(dataF.g, dataF.r), atan(dataF.a, dataF.b));

    vec2 phaseDeltaT = unwrapPhase(phaseT - phaseBase);
    vec2 phaseDeltaF = unwrapPhase(phaseF - phaseBase);

    // *** THE CRITICAL PITCH SHIFT CORRECTION ***
    vec2 correctedPhaseDeltaT = phaseDeltaT * pitchRatio;

    vec2 fracCoord = vec2(xFrac, yFrac);
    vec2 phaseGradientCh1 = vec2(correctedPhaseDeltaT.x, phaseDeltaF.x);
    vec2 phaseGradientCh2 = vec2(correctedPhaseDeltaT.y, phaseDeltaF.y);
    vec2 newPhase = phaseBase + vec2(dot(phaseGradientCh1, fracCoord), dot(phaseGradientCh2, fracCoord));

    vec2 magInterpBottom = mix(magBase, magT, fracCoord.x);
    vec2 magInterpTop = mix(magF, magTf, fracCoord.x);
    vec2 newMag = mix(magInterpBottom, magInterpTop, fracCoord.y);

    vec2 newComplexCh1 = newMag.x * vec2(cos(newPhase.x), sin(newPhase.x));
    vec2 newComplexCh2 = newMag.y * vec2(cos(newPhase.y), sin(newPhase.y));

    return vec4(newComplexCh1, newComplexCh2);
}


/**
 * HIGH QUALITY (PITCH-AWARE): Performs true pitch-shifting and time-stretching.
 * @param sourceUv The logical UV coordinate to sample FROM.
 * @param targetUv The logical UV coordinate of the pixel we are writing TO.
 */
vec4 sampleSpectrogramTransformed(vec2 sourceUv, vec2 targetUv) {
    return _performTransformation(sourceUv, targetUv,
                                 sourceBandCount, sourceBandsPerOctave, sourceMinFreq, sourceFrameCount,
                                 sourceMetadataTex, sourceSpectrogramTex, sourceSpectrogramTextureSize, sourceSampleRate,
                                 destBandCount, destBandsPerOctave, destMinFreq);
}

// Convenience wrapper for display
vec4 samplePointFromScreen(vec2 screenUv) {
    return sampleSpectrogramPointInterpolated(screenToZoomed(screenUv));
}
`;

export const brushMain = /* glsl */ `
precision highp float;
varying vec2 vUv;

// This function must be implemented by the specific brush shader.
vec4 applyBrushStroke(vec4 sourceTexel, Coords coords);

void main() {
    Coords coords = getCoords(vUv);
    vec4 originalTexel = _sampleSpectrogramPointInterpolated(
      coords.dest, 
      destSpectrogramTex, 
      destMetadataTex, 
      destSpectrogramTextureSize, 
      destFrameCount, 
      destBandCount, 
      destSampleRate
    );

    if (isInBrush(coords.dest)) {
        float weight = getFeatherWeight(coords.dest);
        vec4 sourceTexel = sampleSpectrogramTransformed(coords.source, coords.dest);
        vec4 modifiedTexel = applyBrushStroke(sourceTexel, coords);
        gl_FragColor = applyBrushEffect(originalTexel, modifiedTexel, weight, coords);
    } else {
        gl_FragColor = originalTexel;
    }
}
`;

export type CommonUniforms = {
  sourceSpectrogramTex: Texture;
  sourceSpectrogramTextureSize: Vector2;
  sourceInverseMapTex: Texture;
  sourceMetadataTex: Texture;
  sourceMinFreq: number;
  sourceBandsPerOctave: number;
  sourceFrameCount: number;
  sourceBandCount: number;
  sourceChannelCount: number;
  sourceSampleRate: number;
  destSpectrogramTex: Texture;
  destSpectrogramTextureSize: Vector2;
  destInverseMapTex: Texture;
  destMetadataTex: Texture;
  destMinFreq: number;
  destBandsPerOctave: number;
  destFrameCount: number;
  destBandCount: number;
  destChannelCount: number;
  destSampleRate: number;
  originalSpectrogramTex: Texture | null;
  brushCenterUv: Vector2;
  brushSizeUv: Vector2;
  viewZoomPower: number;
  viewOffset: number;
  featherX: number;
  featherY: number;
  brushIntensity: number;
  brushIntensityMod: number;
  offsetUv: Vector2;
  pan: number;
  bpm: number;
  blendMode: number;
  modulatorMode: number;
  modulatorPatternShape: number;
  modulatorPatternRateBeats: number;
  modulatorPatternRateSemis: number;
  modulatorPatternRadial: boolean;
};

export const defaultValues: CommonUniforms = {
  sourceSpectrogramTex: new Texture(),
  sourceInverseMapTex: new Texture(),
  sourceMetadataTex: new Texture(),
  sourceFrameCount: 0,
  sourceBandCount: 0,
  sourceSpectrogramTextureSize: new Vector2(0, 0),
  sourceChannelCount: 1,
  sourceSampleRate: 44100.0,
  sourceMinFreq: 20.0,
  sourceBandsPerOctave: 24.0,
  destSpectrogramTex: new Texture(),
  destInverseMapTex: new Texture(),
  destMetadataTex: new Texture(),
  destFrameCount: 0,
  destBandCount: 0,
  destSpectrogramTextureSize: new Vector2(0, 0),
  destChannelCount: 1,
  destSampleRate: 44100.0,
  destMinFreq: 20.0,
  destBandsPerOctave: 24.0,
  originalSpectrogramTex: new Texture(),
  brushCenterUv: new Vector2(0.5, 0.5),
  brushSizeUv: new Vector2(0.1, 0.1),
  viewZoomPower: 0.0,
  viewOffset: 0.0,
  featherX: 0.5,
  featherY: 0.5,
  brushIntensity: 1.0,
  brushIntensityMod: 0.0,
  offsetUv: new Vector2(0, 0),
  pan: 0.0,
  bpm: 120.0,
  blendMode: 0,
  modulatorMode: 0,
  modulatorPatternShape: 0,
  modulatorPatternRateBeats: 1.0,
  modulatorPatternRateSemis: 0.0,
  modulatorPatternRadial: false,
};

export function unitsToUv(
  beats: number,
  semitones: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
): Vector2 {
  const seconds = beats * (60.0 / bpm);
  const u = seconds / totalDuration;

  const bandsPerSemitone = bandsPerOctave / 12;
  const shiftInBands = semitones * bandsPerSemitone;
  const v = shiftInBands / numBands;

  return new Vector2(u, v);
}

export function uvToUnits(
  u: number,
  v: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
) {
  const seconds = u * totalDuration;
  const beats = seconds / (60.0 / bpm);

  const bandsPerSemitone = bandsPerOctave / 12;
  const semitones = (v * numBands) / bandsPerSemitone;

  return [beats, semitones];
}

export const screenToZoomed = (screenUv: Vector2, viewZoomPower: number, viewOffset: number): Vector2 => {
  const zoom = Math.pow(2, viewZoomPower);
  if (zoom <= 1) {
    return screenUv.clone();
  }
  const viewWidth = 1.0 / zoom;
  const viewStartX = viewOffset * (1.0 - viewWidth);
  return new Vector2(viewStartX + screenUv.x * viewWidth, screenUv.y);
};

export const zoomedToScreen = (zoomedUv: Vector2, viewZoomPower: number, viewOffset: number): Vector2 => {
  const zoom = Math.pow(2, viewZoomPower);
  if (zoom <= 1) {
    return zoomedUv.clone();
  }
  const viewWidth = 1.0 / zoom;
  const viewStartX = viewOffset * (1.0 - viewWidth);
  return new Vector2((zoomedUv.x - viewStartX) / viewWidth, zoomedUv.y);
};
