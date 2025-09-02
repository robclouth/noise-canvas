import { Texture, Vector2 } from "three";

export const vertexShader = /*glsl*/ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

export const code = `
uniform sampler2D packedDataTex;
uniform sampler2D metadataTex;
uniform float numFrames;
uniform float numBands;
uniform vec2 packedTextureSize;
uniform int numChannels;
uniform sampler2D inverseMapTex;
uniform float sampleRate;

// Brush uniforms
uniform vec2 brushCenterUv; // Center of the brush in UV coordinates
uniform vec2 brushSizeUv;   // Size of the brush in UV coordinates

vec4 getDataFromUv(vec2 vUv) {
  float bandIndex = floor((1.0 - vUv.y) * numBands);
    
  vec2 metaUv = vec2((bandIndex + 0.5) / numBands, 0.5);
  vec3 meta = texture2D(metadataTex, metaUv).rgb;
  float bandOffset = meta.r;
  float bandLength = meta.g;
  float bandScaleExp = meta.b;

  float timeSample = vUv.x * numFrames;
  float timeInBand = timeSample / exp2(bandScaleExp);
  float coefIndexInBand = floor(timeInBand);

  if (coefIndexInBand < 0.0 || coefIndexInBand >= bandLength) {
      return vec4(0.0, 0.0, 0.0, 0.0);
  }

  // This is the index of the RGBA "pixel"
  float linearPixelIndex = bandOffset + coefIndexInBand;

  // Convert that to a UV coordinate
  float packedY = floor(linearPixelIndex / packedTextureSize.x);
  float packedX = mod(linearPixelIndex, packedTextureSize.x);
  vec2 packedUv = (vec2(packedX, packedY) + 0.5) / packedTextureSize;
  
  // Fetch the single RGBA texel containing all channel data for this point
  vec4 packedValue = texture2D(packedDataTex, packedUv);

  return packedValue;
}

vec2 getUnpackedUvFromPackedUv(vec2 packedUv) {
    vec2 rawUnpacked = texture2D(inverseMapTex, packedUv).rg;
    vec2 unpackedUv;
    unpackedUv.x = rawUnpacked.x / numFrames;
    unpackedUv.y = 1.0 - (rawUnpacked.y + 0.5) / numBands;
    return unpackedUv;
}

// Check if a given UV coordinate is within the rectangular brush
bool isInBrush(vec2 vUv) {
    vec2 diff = abs(vUv - brushCenterUv);
    return (diff.x < brushSizeUv.x / 2.0 && diff.y < brushSizeUv.y / 2.0);
}
`;

export const uniforms = {
  packedDataTex: new Texture(),
  inverseMapTex: new Texture(),
  metadataTex: new Texture(),
  numFrames: 0,
  numBands: 0,
  packedTextureSize: new Vector2(0, 0),
  numChannels: 1,
  sampleRate: 44100.0,
  brushCenterUv: new Vector2(0.5, 0.5),
  brushSizeUv: new Vector2(0.1, 0.1),
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
