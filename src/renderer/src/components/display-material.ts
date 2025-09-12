import { shaderMaterial } from "@react-three/drei";
import { code, uniforms } from "./brushes/common";

export const DisplayMaterial = shaderMaterial(
  {
    ...uniforms,
    minDb: -70.0,
    maxDb: 0.0,
    bpm: 120.0,
    gridSize: 0.25,
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

// The refactored common code with new function names
${code}

// Uniforms specific to this display material
uniform float minDb;
uniform float maxDb;
uniform float bpm;
uniform float gridSize;

varying vec2 vUv;

float magnitudeToDb(float mag) {
    float logMag = 20.0 * log(mag + 1.0e-7) / log(10.0);
    float db = (logMag - minDb) / (maxDb - minDb);
    return clamp(db, 0.0, 1.0);
}

void main() {
    vec4 packedValue = samplePointFromScreen(vUv);

    vec2 leftComplex = packedValue.rg;
    float leftMag = length(leftComplex);
    float leftDb = magnitudeToDb(leftMag);
    
    vec3 color;
    if (numChannels == 1) {
        color = vec3(leftDb);
    } else {
        vec2 rightComplex = packedValue.ba;
        float rightMag = length(rightComplex);
        float rightDb = magnitudeToDb(rightMag);
        
        vec3 leftColor = vec3(leftDb, leftDb * 0.5, 0.0);
        vec3 rightColor = vec3(0.0, rightDb * 0.5, rightDb);
        color = leftColor + rightColor;
    }

    // Grid lines
    float gridIntervalSeconds = (60.0 / bpm) * gridSize;
    float totalDuration = numFrames / sampleRate;
    float gridWidthUv = gridIntervalSeconds / totalDuration;
    
    vec2 zoomedUv = screenToZoomed(vUv);
    float line = mod(zoomedUv.x, gridWidthUv);

    float lineThicknessUv = fwidth(zoomedUv.x);

    if (line < lineThicknessUv) {
        color = mix(color, vec3(1.0), 0.2);
    }

    gl_FragColor = vec4(color, 1.0);
}
`,
);
