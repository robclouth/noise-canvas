import { DataTexture, Vector2 } from "three";

export const code = `

uniform sampler2D uPackedData;
uniform sampler2D uMetadata;
uniform float uNumFrames;
uniform float uNumBands;
uniform vec2 uPackedTextureSize;
uniform int uNumChannels;
uniform float uInverseMap;

vec4 getDataFromUv(vec2 vUv) {
  float bandIndex = floor((1.0 - vUv.y) * uNumBands);
    
  vec2 metaUv = vec2((bandIndex + 0.5) / uNumBands, 0.5);
  vec3 meta = texture2D(uMetadata, metaUv).rgb;
  float bandOffset = meta.r;
  float bandLength = meta.g;
  float bandScaleExp = meta.b;

  float timeSample = vUv.x * uNumFrames;
  float timeInBand = timeSample / exp2(bandScaleExp);
  float coefIndexInBand = floor(timeInBand);

  if (coefIndexInBand < 0.0 || coefIndexInBand >= bandLength) {
      return vec4(0.0, 0.0, 0.0, 0.0);
  }

  // This is the index of the RGBA "pixel"
  float linearPixelIndex = bandOffset + coefIndexInBand;

  // Convert that to a UV coordinate
  float packedY = floor(linearPixelIndex / uPackedTextureSize.x);
  float packedX = mod(linearPixelIndex, uPackedTextureSize.x);
  vec2 packedUv = (vec2(packedX, packedY) + 0.5) / uPackedTextureSize;

  // Fetch the single RGBA texel containing all channel data for this point
  vec4 packedValue = texture2D(uPackedData, packedUv);

  return packedValue;
}
`;

export const uniform = {
  uPackedData: new DataTexture(),
  uInverseMap: new DataTexture(),
  uMetadata: new DataTexture(),
  uNumFrames: 0,
  uNumBands: 0,
  uPackedTextureSize: new Vector2(0, 0),
  uNumChannels: 1,
};
