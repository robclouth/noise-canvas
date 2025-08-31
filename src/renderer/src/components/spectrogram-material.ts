import { shaderMaterial } from "@react-three/drei";
import { DataTexture, Vector2 } from "three";

export const SpectrogramMaterial = shaderMaterial(
  {
    uPackedData: new DataTexture(),
    uMetadata: new DataTexture(),
    uNumFrames: 0,
    uNumBands: 0,
    uPackedTextureSize: new Vector2(0, 0),
    uMinDB: -50.0,
    uMaxDB: 0.0,
    uNumChannels: 1,
  },
  /*glsl*/ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`,
  /*glsl*/ `
precision highp float;

uniform sampler2D uPackedData;
uniform sampler2D uMetadata;

uniform float uNumFrames;
uniform float uNumBands;
uniform vec2 uPackedTextureSize;
uniform float uMinDB;
uniform float uMaxDB;
uniform int uNumChannels;

varying vec2 vUv;

float magnitudeToDb(float mag) {
    float logMag = 20.0 * log(mag + 1.0e-7) / log(10.0); // Use a smaller epsilon
    float db = (logMag - uMinDB) / (uMaxDB - uMinDB);
    return clamp(db, 0.0, 1.0);
}

void main() {
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
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // This is the index of the RGBA "pixel"
    float linearPixelIndex = bandOffset + coefIndexInBand;

    // Convert that to a UV coordinate
    float packedY = floor(linearPixelIndex / uPackedTextureSize.x);
    float packedX = mod(linearPixelIndex, uPackedTextureSize.x);
    vec2 packedUv = (vec2(packedX, packedY) + 0.5) / uPackedTextureSize;

    // Fetch the single RGBA texel containing all channel data for this point
    vec4 packedValue = texture2D(uPackedData, packedUv);

    vec2 leftComplex = packedValue.rg; // R=Real, G=Imag
    float leftMag = length(leftComplex);
    float leftDb = magnitudeToDb(leftMag);
    
    if (uNumChannels == 1) {
        gl_FragColor = vec4(leftDb, leftDb, leftDb, 1.0);
    } else {
        vec2 rightComplex = packedValue.ba; // B=Real, A=Imag
        float rightMag = length(rightComplex);
        float rightDb = magnitudeToDb(rightMag);
        // Visualize L in Red, R in Blue
        gl_FragColor = vec4(leftDb, 0.0, rightDb, 1.0);
    }
}
`,
);
