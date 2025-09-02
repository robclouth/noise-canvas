import { shaderMaterial } from "@react-three/drei";
import { code, uniforms } from "./brushes/common";

const DisplayMaterial = shaderMaterial(
  {
    ...uniforms,
    minDB: -70.0,
    maxDB: 0.0,
    bpm: 120.0,
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
uniform float bpm;


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
    
    vec3 color;
    if (numChannels == 1) {
        color = vec3(leftDb, leftDb, leftDb);
    } else {
        vec2 rightComplex = packedValue.ba; // B=Real, A=Imag
        float rightMag = length(rightComplex);
        float rightDb = magnitudeToDb(rightMag);
        // Visualize L in Red, R in Blue
        color = vec3(leftDb, 0.0, rightDb);
    }

    // Grid lines
    float beatDuration = 60.0 / bpm;
    float totalDuration = numFrames / sampleRate;
    float beatWidthUv = beatDuration / totalDuration;
    float subBeatWidthUv = beatWidthUv / 4.0;

    float beatLine = mod(vUv.x, beatWidthUv);
    float subBeatLine = mod(vUv.x, subBeatWidthUv);

    float lineThicknessUv = 0.0005; 

    if (beatLine < lineThicknessUv) {
        color = mix(color, vec3(0.5), 0.7); // Stronger line for beats
    } else if (subBeatLine < lineThicknessUv) {
        color = mix(color, vec3(0.2), 0.7); // Fainter line for sub-beats
    }

    gl_FragColor = vec4(color, 1.0);
}
`,
);

export const displayMaterial = new DisplayMaterial();
