import { DataTexture, Vector2 } from "three";

export const code = `

uniform sampler2D packedDataTex;
uniform sampler2D metadataTex;
uniform float numFrames;
uniform float numBands;
uniform vec2 packedTextureSize;
uniform int numChannels;
uniform float inverseMapTex;

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
`;

export const uniforms = {
  packedDataTex: new DataTexture(),
  inverseMapTex: new DataTexture(),
  metadataTex: new DataTexture(),
  numFrames: 0,
  numBands: 0,
  packedTextureSize: new Vector2(0, 0),
  numChannels: 1,
};
