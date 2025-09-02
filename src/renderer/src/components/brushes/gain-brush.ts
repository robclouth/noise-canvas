import { shaderMaterial } from "@react-three/drei";
import * as THREE from "three";
import { code, uniforms, vertexShader } from "./common";
import { BaseBrush } from "./base-brush";

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

  constructor() {
    super();
    this.material = new GainMaterial();
  }

  updateUniforms(props: Record<string, any>) {
    if (this.material.uniforms.gainAmount) {
      this.material.uniforms.gainAmount.value = props.gainAmount;
    }
  }
}

export const gainBrush = new GainBrush();
