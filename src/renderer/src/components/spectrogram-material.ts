import { shaderMaterial } from "@react-three/drei";
import { code, uniforms } from "./brushes/common";

const DisplayMaterial = shaderMaterial(
  {
    ...uniforms,
    minDB: -70.0,
    maxDB: 0.0,
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

${code}

uniform float minDB;
uniform float maxDB;


varying vec2 vUv;

float magnitudeToDb(float mag) {
    float logMag = 20.0 * log(mag + 1.0e-7) / log(10.0); // Use a smaller epsilon
    float db = (logMag - minDB) / (maxDB - minDB);
    return clamp(db, 0.0, 1.0);
}

void main() {
    
    vec4 packedValue = getDataFromUv(vUv);

    vec2 leftComplex = packedValue.rg; // R=Real, G=Imag
    float leftMag = length(leftComplex);
    float leftDb = magnitudeToDb(leftMag);
    
    if (numChannels == 1) {
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

export const displayMaterial = new DisplayMaterial();
