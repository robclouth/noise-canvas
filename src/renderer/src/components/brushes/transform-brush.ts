import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { bandsPerOctaveAtom, bpmAtom, fminAtom, spectrogramDataAtom, store } from "../../store";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { code, uniforms, unitsToUv, vertexShader } from "./common";

export const boundaryModes = ["smear", "cut", "wrap"] as const;
export type BoundaryMode = (typeof boundaryModes)[number];

export const shiftXAtom = atomWithStorage("shiftX", 0.0);
export const shiftYCentsAtom = atomWithStorage("shiftYCents", 0.0);
export const scaleXAtom = atomWithStorage("scaleX", 1.0);
export const scaleYAtom = atomWithStorage("scaleY", 1.0);
export const rotationAtom = atomWithStorage("rotation", 0.0);
export const boundaryModeAtom = atomWithStorage<BoundaryMode>("boundaryMode", "cut");

const TransformMaterial = shaderMaterial(
  {
    ...uniforms,
    shiftUv: new THREE.Vector2(0.0, 0.0),
    scale: new THREE.Vector2(1.0, 1.0),
    rotation: 0.0,
    boundaryMode: 0,
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform vec2 shiftUv;
    uniform vec2 scale;
    uniform float rotation;
    uniform int boundaryMode;

    ${code}

    void main() {
        vec2 unpackedUv = getUnpackedUvFromPackedUv(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(unpackedUv)) {
            vec2 relativeUv = unpackedUv - brushCenterUv;

            if (scale.x != 0.0 && scale.y != 0.0) {
              relativeUv /= scale;
            }

            float rad = radians(-rotation);
            mat2 rotMat = mat2(cos(rad), -sin(rad), sin(rad), cos(rad));
            relativeUv = rotMat * relativeUv;

            vec2 transformedUv = relativeUv + brushCenterUv;
            vec2 finalSourceUv = transformedUv - shiftUv;
            
            vec4 transformedTexel;
            vec2 targetUv = unpackedUv; // The destination is the current pixel

            if (isInBrush(finalSourceUv)) {
                transformedTexel = sampleSpectrogramTransformed(finalSourceUv, targetUv);
            } else {
                if (boundaryMode == 0) { // Smear
                    transformedTexel = sampleSpectrogramTransformed(finalSourceUv, targetUv);
                } else if (boundaryMode == 1) { // Cut
                    transformedTexel = vec4(0.0); 
                } else { // Wrap
                    vec2 wrappedSourceUv = fract(finalSourceUv);
                    transformedTexel = sampleSpectrogramTransformed(wrappedSourceUv, targetUv);
                }
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
        formatValue: (v) => `${v.toFixed(2)} beats`,
      },
      {
        type: "slider",
        atom: shiftYCentsAtom,
        label: "Shift Y",
        propName: "shiftYCents",
        min: -1200,
        max: 1200,
        step: 10,
        formatValue: (v) => `${v.toFixed(0)} cents`,
      },
      {
        type: "slider",
        atom: scaleXAtom,
        label: "Scale X",
        propName: "scaleX",
        min: -4.0,
        max: 4.0,
        step: 0.01,
        formatValue: (v) => `${(v * 100).toFixed(0)}%`,
      },
      {
        type: "slider",
        atom: scaleYAtom,
        label: "Scale Y",
        propName: "scaleY",
        min: -4.0,
        max: 4.0,
        step: 0.01,
        formatValue: (v) => `${(v * 100).toFixed(0)}%`,
      },
      {
        type: "slider",
        atom: rotationAtom,
        label: "Rotation",
        propName: "rotation",
        min: -180,
        max: 180,
        step: 1,
        formatValue: (v) => `${v.toFixed(0)}°`,
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
    const bandsPerOctave = store.get(bandsPerOctaveAtom);
    const minFreq = store.get(fminAtom);

    if (!spectrogramData) return;

    // Update new uniforms for pitch shifting
    this.material.uniforms.minFreq.value = minFreq;
    this.material.uniforms.bandsPerOctave.value = bandsPerOctave;

    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const shiftUv = unitsToUv(
      store.get(shiftXAtom),
      store.get(shiftYCentsAtom) / 100,
      bpm,
      totalDuration,
      bandsPerOctave,
      spectrogramData.numBands,
    );

    this.material.uniforms.shiftUv.value.copy(shiftUv);
    this.material.uniforms.scale.value.set(store.get(scaleXAtom), store.get(scaleYAtom));
    this.material.uniforms.rotation.value = store.get(rotationAtom);
    this.material.uniforms.boundaryMode.value = boundaryModes.indexOf(store.get(boundaryModeAtom));
  }
}

export const transformBrush = new TransformBrush();
