import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { analysisParams, bpmAtom, spectrogramDataAtom, store } from "../../store";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { code, uniforms, unitsToUv, vertexShader } from "./common";

export const boundaryModes = ["smear", "cut", "wrap"] as const;
export type BoundaryMode = (typeof boundaryModes)[number];

export const shiftXAtom = atomWithStorage("shiftX", 0.0); // in beats
export const shiftYCentsAtom = atomWithStorage("shiftYCents", 0.0); // in cents
export const scaleXAtom = atomWithStorage("scaleX", 1.0); // as a factor
export const scaleYAtom = atomWithStorage("scaleY", 1.0); // as a factor
export const rotationAtom = atomWithStorage("rotation", 0.0); // in degrees
export const boundaryModeAtom = atomWithStorage<BoundaryMode>("boundaryMode", "cut");

const TransformMaterial = shaderMaterial(
  {
    ...uniforms,
    shiftUv: new THREE.Vector2(0.0, 0.0),
    scale: new THREE.Vector2(1.0, 1.0),
    rotation: 0.0, // in degrees
    boundaryMode: 0, // 0: smear, 1: cut, 2: wrap
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform vec2 shiftUv;
    uniform vec2 scale;
    uniform float rotation;
    uniform int boundaryMode; // 0: smear, 1: cut, 2: wrap

    ${code}

    void main() {
        vec2 unpackedUv = getUnpackedUvFromPackedUv(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(unpackedUv)) {
            vec2 relativeUv = unpackedUv - brushCenterUv;

            // Inverse Scale
            if (scale.x != 0.0 && scale.y != 0.0) {
              relativeUv /= scale;
            }

            // Inverse Rotation
            float rad = radians(-rotation);
            float s = sin(rad);
            float c = cos(rad);
            mat2 rotMat = mat2(c, -s, s, c);
            relativeUv = rotMat * relativeUv;

            vec2 transformedUv = relativeUv + brushCenterUv;
            vec2 finalSourceUv = transformedUv - shiftUv;
            
            vec4 transformedTexel;

            if (isInBrush(finalSourceUv)) {
                transformedTexel = getDataFromLogicalUv(finalSourceUv);
            } else {
                if (boundaryMode == 0) { // Smear
                    transformedTexel = getDataFromLogicalUv(finalSourceUv);
                } else if (boundaryMode == 1) { // Cut
                    transformedTexel = vec4(0.0); 
                } else { // Wrap
                    finalSourceUv = fract(finalSourceUv);
                    transformedTexel = getDataFromLogicalUv(finalSourceUv);
                }
            }

            if (scale.x < 0.0) {
                // For a clean time-reversal, we must apply a complex conjugation
                // to the spectral data, which corresponds to negating the phase.
                // Ch 1 Imaginary: .g, Ch 2 Imaginary: .a
                transformedTexel.g = -transformedTexel.g;
                transformedTexel.a = -transformedTexel.a;
            }
            
            float weight = getFeatherWeight(unpackedUv);
            gl_FragColor = mix(originalTexel, transformedTexel, weight);
        } else {
            gl_FragColor = originalTexel;
        }
    }
  `,
);

class TransformBrush extends BaseBrush {
  material: THREE.ShaderMaterial;
  parameters: BrushParameter[];

  constructor() {
    super();
    this.material = new TransformMaterial();
    this.parameters = [
      {
        type: "slider",
        atom: shiftXAtom,
        label: "Shift X",
        propName: "shiftX",
        min: 0.0,
        max: 1.0,
        step: 1 / 16,
        formatValue: (value) => `${value.toFixed(2)} beats`,
      },
      {
        type: "slider",
        atom: shiftYCentsAtom,
        label: "Shift Y",
        propName: "shiftYCents",
        min: -1200,
        max: 1200,
        step: 10,
        formatValue: (value) => `${value.toFixed(0)} cents`,
      },
      {
        type: "slider",
        atom: scaleXAtom,
        label: "Scale X",
        propName: "scaleX",
        min: -4.0,
        max: 4.0,
        step: 0.01,
        formatValue: (value) => `${(value * 100).toFixed(0)}%`,
      },
      {
        type: "slider",
        atom: scaleYAtom,
        label: "Scale Y",
        propName: "scaleY",
        min: -4.0,
        max: 4.0,
        step: 0.01,
        formatValue: (value) => `${(value * 100).toFixed(0)}%`,
      },
      {
        type: "slider",
        atom: rotationAtom,
        label: "Rotation",
        propName: "rotation",
        min: -180,
        max: 180,
        step: 1,
        formatValue: (value) => `${value.toFixed(0)}°`,
      },
      {
        type: "select",
        atom: boundaryModeAtom,
        label: "Boundary Mode",
        propName: "boundaryMode",
        options: boundaryModes,
      },
    ];
  }

  updateUniforms(props: UpdateUniformsProps): void {
    super.updateUniforms(props);
    const spectrogramData = store.get(spectrogramDataAtom);
    const bpm = store.get(bpmAtom);
    const shiftX = store.get(shiftXAtom);
    const shiftYCents = store.get(shiftYCentsAtom);
    const scaleX = store.get(scaleXAtom);
    const scaleY = store.get(scaleYAtom);
    const rotation = store.get(rotationAtom);
    const boundaryMode = store.get(boundaryModeAtom);

    if (!spectrogramData) return;

    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const shiftUv = unitsToUv(
      shiftX,
      shiftYCents / 100, // convert cents to semitones
      bpm,
      totalDuration,
      analysisParams.bandsPerOctave,
      spectrogramData.numBands,
    );

    this.material.uniforms.shiftUv.value.copy(shiftUv);
    this.material.uniforms.scale.value.set(scaleX, scaleY);
    this.material.uniforms.rotation.value = rotation;
    this.material.uniforms.boundaryMode.value = boundaryModes.indexOf(boundaryMode);
  }
}

export const transformBrush = new TransformBrush();
