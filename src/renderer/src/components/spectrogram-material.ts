import { shaderMaterial } from "@react-three/drei";
import { DataTexture } from "three";

export const SpectrogramMaterial = shaderMaterial(
  {
    uSpectrogramData: new DataTexture(),
    uMinDB: -10.0,
    uMaxDB: 0.0,
    uChannels: 1,
  },
  /*glsl*/ `
out vec2 vUv;

void main(){
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`,
  /*glsl*/ `
precision highp float;

uniform sampler2D uSpectrogramData;
uniform float uMinDB;
uniform float uMaxDB;
uniform int uChannels;

in vec2 vUv;

float magnitudeToDb(float mag) {
    float logMag = log(mag + 1.0e-6); // Use small epsilon to avoid log(0)
    float db = (logMag - uMinDB) / (uMaxDB - uMinDB);
    return clamp(db, 0.0, 1.0);
}

void main() {
    vec4 texel = texture2D(uSpectrogramData, vUv);
    
    vec2 leftComplex = texel.rg;
    vec2 rightComplex = texel.ba;

    float leftMag = length(leftComplex);
    float rightMag = length(rightComplex);
    
    float leftDb = magnitudeToDb(leftMag);
    float rightDb = magnitudeToDb(rightMag);

    gl_FragColor = vec4(leftDb, rightDb, 0.0, 1.0);
}
`,
);
