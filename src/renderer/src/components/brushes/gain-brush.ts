import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { code, uniforms, vertexShader } from "./common";
import { BaseBrush, BrushParameter } from "./base-brush";

export const gainAmountAtom = atomWithStorage("gainAmount", 1.0);

const GainMaterial = shaderMaterial(
  {
    ...uniforms,
    gainAmount: 1.0,
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform float gainAmount;

    ${code}

    void main() {
        vec2 unpackedUv = getUnpackedUvFromPackedUv(vUv);

        vec4 texel = texture2D(packedDataTex, vUv);

        if (isInBrush(unpackedUv)) {
            // Apply gain to the complex numbers (real and imaginary parts)
            // For mono, this affects .rg. For stereo, it affects all four channels.
            texel *= gainAmount;
        }

        gl_FragColor = texel;
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
        atom: gainAmountAtom,
        label: "Gain Amount",
        min: 0,
        max: 10,
        step: 0.1,
        formatValue: (value) => value.toFixed(2),
      },
    ];
  }

  updateUniforms(props: Record<string, any>) {
    if (this.material.uniforms.gainAmount) {
      this.material.uniforms.gainAmount.value = props.gainAmount;
    }
  }
}

export const gainBrush = new GainBrush();
