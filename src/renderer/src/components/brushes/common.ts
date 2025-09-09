import { Texture, Vector2 } from "three";

export const vertexShader = /*glsl*/ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

export const code = /* glsl */ `
/**
 * =============================================================================
 * Common Spectrogram GLSL Utilities (Pitch-Shift Aware)
 * =============================================================================
 */

//------------------------------------------------------------------------------
// Uniforms
//------------------------------------------------------------------------------
uniform sampler2D packedDataTex;
uniform sampler2D metadataTex;
uniform sampler2D inverseMapTex;
uniform vec2 packedTextureSize;
uniform float numFrames;
uniform float numBands;
uniform int numChannels;
uniform float sampleRate;
uniform float pi;

// New uniforms required for true pitch shifting
uniform float minFreq;
uniform float bandsPerOctave;

// Source texture uniforms
uniform bool sourceSelected;
uniform sampler2D sourceTexture;
uniform sampler2D sourceMetadataTex;
uniform vec2 sourcePackedTextureSize;
uniform float sourceNumFrames;
uniform float sourceNumBands;
uniform float sourceMinFreq;
uniform float sourceBandsPerOctave;
uniform float sourceSampleRate;

// Brush & View Uniforms
uniform vec2 brushCenterUv;
uniform vec2 brushSizeUv;
uniform float zoomPower;
uniform float scroll;
uniform float featherX;
uniform float featherY;
uniform vec2 offsetUv;
uniform float pan;
uniform float brushIntensity;

//------------------------------------------------------------------------------
// Coordinate System & Helpers
//------------------------------------------------------------------------------
struct Coords {
    vec2 dest;
    vec2 source;
};

vec2 screenToZoomed(vec2 screenUv) {
  float zoom = pow(2.0, zoomPower);
  if (zoom <= 1.0) { return screenUv; }
  float viewWidth = 1.0 / zoom;
  float viewStartX = scroll * (1.0 - viewWidth);
  return vec2(viewStartX + screenUv.x * viewWidth, screenUv.y);
}

vec2 zoomedToScreen(vec2 zoomedUv) {
    float zoom = pow(2.0, zoomPower);
    if (zoom <= 1.0) { return zoomedUv; }
    float viewWidth = 1.0 / zoom;
    float viewStartX = scroll * (1.0 - viewWidth);
    return vec2((zoomedUv.x - viewStartX) / viewWidth, zoomedUv.y);
}

vec2 getUnpackedUvFromPackedUv(vec2 packedUv) {
    vec2 rawUnpacked = texture2D(inverseMapTex, packedUv).rg;
    vec2 unpackedUv;
    unpackedUv.x = rawUnpacked.x / numFrames;
    unpackedUv.y = 1.0 - (rawUnpacked.y + 0.5) / numBands;
    return unpackedUv;
}

Coords getCoords(vec2 packedUv) {
    Coords c;
    c.dest = getUnpackedUvFromPackedUv(packedUv);
    c.source = c.dest - offsetUv;
    return c;
}

vec4 applyBrushEffect(vec4 original, vec4 modified, float weight) {
    vec2 originalL = original.rg;
    vec2 originalR = original.ba;
    vec2 modifiedL = modified.rg;
    vec2 modifiedR = modified.ba;

    float leftWeight = clamp(1.0 - pan, 0.0, 1.0);
    float rightWeight = clamp(1.0 + pan, 0.0, 1.0);

    vec2 finalL = mix(originalL, modifiedL, weight * brushIntensity * leftWeight);
    vec2 finalR = mix(originalR, modifiedR, weight * brushIntensity * rightWeight);

    return vec4(finalL, finalR);
}

bool isInBrush(vec2 logicalUv) {
    vec2 diff = abs(logicalUv - brushCenterUv);
    return (diff.x < brushSizeUv.x / 2.0 && diff.y < brushSizeUv.y / 2.0);
}

float getFeatherWeight(vec2 logicalUv) {
    if (!isInBrush(logicalUv)) { return 0.0; }
    vec2 diff = abs(logicalUv - brushCenterUv) / brushSizeUv;
    float featherZoneX = 0.5 * featherX;
    float featherZoneY = 0.5 * featherY;
    float weightX = smoothstep(0.5, 0.5 - featherZoneX, diff.x);
    float weightY = smoothstep(0.5, 0.5 - featherZoneY, diff.y);
    return weightX * weightY;
}

vec2 unwrapPhase(vec2 phaseDelta) {
    return mod(phaseDelta + pi, 2.0 * pi) - pi;
}

/**
 * Converts a vertical logical UV coordinate to its corresponding frequency in Hz.
 */
float uvToHz(float v) {
    float totalOctaves = numBands / bandsPerOctave;
    float octave = (1.0 - v) * totalOctaves;
    return minFreq * pow(2.0, octave);
}

/**
 * Converts a frequency in Hz to its corresponding vertical logical UV coordinate.
 */
float hzToUv(float hz) {
    if (hz < minFreq) return 1.0;
    float octave = log2(hz / minFreq);
    float totalOctaves = numBands / bandsPerOctave;
    return 1.0 - (octave / totalOctaves);
}

//------------------------------------------------------------------------------
// Core Sampling Logic (Final Version)
//------------------------------------------------------------------------------

vec4 sampleSpectrogramPoint(vec2 logicalUv, sampler2D data, sampler2D meta, vec2 texSize, float nFrames, float nBands, float sRate) {
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

vec4 sampleFromSource(vec2 logicalUv) {
    if (sourceSelected) {
        return sampleSpectrogramPoint(logicalUv, sourceTexture, sourceMetadataTex, sourcePackedTextureSize, sourceNumFrames, sourceNumBands, sourceSampleRate);
    }
    return sampleSpectrogramPoint(logicalUv, packedDataTex, metadataTex, packedTextureSize, numFrames, numBands, sampleRate);
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

    vec4 dataBase = sampleSpectrogramPoint(uvBase, srcData, srcMeta, srcTexSize, srcNFrames, srcNBands, srcSRate);
    vec4 dataT = sampleSpectrogramPoint(uvT, srcData, srcMeta, srcTexSize, srcNFrames, srcNBands, srcSRate);
    vec4 dataF = sampleSpectrogramPoint(uvF, srcData, srcMeta, srcTexSize, srcNFrames, srcNBands, srcSRate);
    vec4 dataTf = sampleSpectrogramPoint(uvTf, srcData, srcMeta, srcTexSize, srcNFrames, srcNBands, srcSRate);

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
    if (sourceSelected) {
        return _performTransformation(sourceUv, targetUv,
                                     sourceNumBands, sourceBandsPerOctave, sourceMinFreq, sourceNumFrames,
                                     sourceMetadataTex, sourceTexture, sourcePackedTextureSize, sourceSampleRate,
                                     numBands, bandsPerOctave, minFreq);
    } else {
        return _performTransformation(sourceUv, targetUv,
                                     numBands, bandsPerOctave, minFreq, numFrames,
                                     metadataTex, packedDataTex, packedTextureSize, sampleRate,
                                     numBands, bandsPerOctave, minFreq);
    }
}

// Convenience wrapper for display
vec4 samplePointFromScreen(vec2 screenUv) {
    return sampleSpectrogramPoint(screenToZoomed(screenUv), packedDataTex, metadataTex, packedTextureSize, numFrames, numBands, sampleRate);
}
`;

export const uniforms = {
  packedDataTex: new Texture(),
  inverseMapTex: new Texture(),
  metadataTex: new Texture(),
  sourceTexture: null as Texture | null,
  numFrames: 0,
  numBands: 0,
  packedTextureSize: new Vector2(0, 0),
  numChannels: 1,
  sampleRate: 44100.0,
  pi: Math.PI,
  minFreq: 20.0,
  bandsPerOctave: 24.0,

  sourceSelected: false,
  sourceMetadataTex: new Texture(),
  sourcePackedTextureSize: new Vector2(0, 0),
  sourceNumFrames: 0,
  sourceNumBands: 0,
  sourceMinFreq: 20.0,
  sourceBandsPerOctave: 24.0,
  sourceSampleRate: 44100.0,

  brushCenterUv: new Vector2(0.5, 0.5),
  brushSizeUv: new Vector2(0.1, 0.1),
  zoomPower: 0.0,
  scroll: 0.0,
  featherX: 0.5,
  featherY: 0.5,
  brushIntensity: 1.0,
  offsetUv: new Vector2(0, 0),
  pan: 0.0,
};

export const unitsToUv = (
  beats: number,
  semitones: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  totalBands: number,
): Vector2 => {
  const uv = new Vector2();
  const seconds = beats * (60.0 / bpm);
  uv.x = seconds / totalDuration;
  const bandsPerSemitone = bandsPerOctave / 12.0;
  const shiftInBands = semitones * bandsPerSemitone;
  uv.y = shiftInBands / totalBands;
  return uv;
};

export const uvToUnits = (
  uv: Vector2,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  totalBands: number,
): [number, number] => {
  const seconds = uv.x * totalDuration;
  const beats = seconds / (60.0 / bpm);

  const bandsPerSemitone = bandsPerOctave / 12.0;
  const shiftedBands = uv.y * totalBands;
  const semitones = shiftedBands / bandsPerSemitone;

  return [beats, semitones];
};

export const screenToZoomed = (screenUv: Vector2, zoomPower: number, scroll: number): Vector2 => {
  const zoom = Math.pow(2, zoomPower);
  if (zoom <= 1) {
    return screenUv.clone();
  }
  const viewWidth = 1.0 / zoom;
  const viewStartX = scroll * (1.0 - viewWidth);
  return new Vector2(viewStartX + screenUv.x * viewWidth, screenUv.y);
};

export const zoomedToScreen = (zoomedUv: Vector2, zoomPower: number, scroll: number): Vector2 => {
  const zoom = Math.pow(2, zoomPower);
  if (zoom <= 1) {
    return zoomedUv.clone();
  }
  const viewWidth = 1.0 / zoom;
  const viewStartX = scroll * (1.0 - viewWidth);
  return new Vector2((zoomedUv.x - viewStartX) / viewWidth, zoomedUv.y);
};
