import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { code, unitsToUv, uniforms, vertexShader } from "./common";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { store, spectrogramDataAtom, bpmAtom, analysisParams } from "../../store";

export const shiftWrapModes = ["smear", "cut", "wrap"] as const;
export type ShiftWrapMode = (typeof shiftWrapModes)[number];

export const shiftXAtom = atomWithStorage("shiftX", 0.0); // in beats
export const shiftYAtom = atomWithStorage("shiftY", 0.0); // in semitones
export const shiftWrapModeAtom = atomWithStorage<ShiftWrapMode>("shiftWrapMode", "cut");

const ShiftMaterial = shaderMaterial(
  {
    ...uniforms,
    shiftUv: new THREE.Vector2(0.0, 0.0),
    wrapMode: 0, // 0: smear, 1: cut, 2: wrap
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform vec2 shiftUv;
    uniform int wrapMode; // 0: smear, 1: cut, 2: wrap

    ${code}

    void main() {
        vec2 unpackedUv = getUnpackedUvFromPackedUv(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(unpackedUv)) {
            vec2 unpackedSourceUv = unpackedUv - shiftUv;

            if (isInBrush(unpackedSourceUv)) {
                gl_FragColor = getDataFromUv(unpackedSourceUv);
            } else {
                if (wrapMode == 0) { // Smear
                    gl_FragColor = getDataFromUv(unpackedSourceUv);
                } else if (wrapMode == 1) { // Cut
                    gl_FragColor = vec4(0.0); 
                } else if (wrapMode == 2) { // Wrap
                    unpackedSourceUv = fract(unpackedSourceUv);
                    gl_FragColor = getDataFromUv(unpackedSourceUv);
                }
            }
        } else {
            gl_FragColor = originalTexel;
        }
    }
  `,
);

class ShiftBrush extends BaseBrush {
  material: THREE.ShaderMaterial;
  parameters: BrushParameter[];

  constructor() {
    super();
    this.material = new ShiftMaterial();
    this.parameters = [
      {
        type: "slider",
        atom: shiftXAtom,
        label: "Shift X",
        propName: "shiftX",
        min: -1.0,
        max: 1.0,
        step: 1 / 16,
        formatValue: (value) => `${value.toFixed(2)} beats`,
      },
      {
        type: "slider",
        atom: shiftYAtom,
        label: "Shift Y",
        propName: "shiftY",
        min: -12,
        max: 12,
        step: 1,
        formatValue: (value) => `${value.toFixed(0)} semitones`,
      },
      {
        type: "select",
        atom: shiftWrapModeAtom,
        label: "Wrap Mode",
        propName: "shiftWrapMode",
        options: shiftWrapModes,
      },
    ];
  }

  updateUniforms(props: UpdateUniformsProps): void {
    super.updateUniforms(props);
    const spectrogramData = store.get(spectrogramDataAtom);
    const bpm = store.get(bpmAtom);
    const shiftX = store.get(shiftXAtom);
    const shiftY = store.get(shiftYAtom);
    const shiftWrapMode = store.get(shiftWrapModeAtom);

    if (!spectrogramData) return;

    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const shiftUv = unitsToUv(
      shiftX,
      shiftY,
      bpm,
      totalDuration,
      analysisParams.bandsPerOctave,
      spectrogramData.numBands,
    );

    this.material.uniforms.shiftUv.value.copy(shiftUv);
    this.material.uniforms.wrapMode.value = shiftWrapModes.indexOf(shiftWrapMode);
  }
}

export const shiftBrush = new ShiftBrush();
