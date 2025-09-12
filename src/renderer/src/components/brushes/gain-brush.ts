import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { code, uniforms, vertexShader } from "./common";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { store } from "../../store";

export const gainDbAtom = atomWithStorage("gainDb", 0.0);

const GainMaterial = shaderMaterial(
  {
    ...uniforms,
    gainDb: 0.0,
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform float gainDb;

    ${code}

    void main() {
        Coords coords = getCoords(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(coords.dest)) {
            float weight = getFeatherWeight(coords.dest);
            float gain = pow(10.0, gainDb / 20.0);
            
            vec4 sourceTexel = sampleSpectrogramTransformed(coords.source, coords.dest);
            vec4 modifiedTexel = sourceTexel * gain;

            gl_FragColor = applyBrushEffect(originalTexel, modifiedTexel, weight);
        } else {
            gl_FragColor = originalTexel;
        }
    }
  `,
);

class GainBrush extends BaseBrush {
  material: THREE.ShaderMaterial;
  parameters: BrushParameter[];

  constructor() {
    super();
    this.material = new GainMaterial();
    this.parameters = [
      {
        type: "slider",
        atom: gainDbAtom,
        label: "Gain",
        propName: "gainDb",
        min: -60,
        max: 6,
        step: 0.1,
        unit: "dB",
        formatValue: (value) => `${value.toFixed(1)}`,
      },
    ];
  }

  updateUniforms(props: UpdateUniformsProps) {
    super.updateUniforms(props);
    this.material.uniforms.gainDb.value = store.get(gainDbAtom);
  }
}

export const gainBrush = new GainBrush();
