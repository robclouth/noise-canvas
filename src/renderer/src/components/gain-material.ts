import { shaderMaterial } from "@react-three/drei";
import { code, uniforms } from "./common";

export const GainMaterial = shaderMaterial(
  {
    ...uniforms,
  },
  /*glsl*/ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    ${code}

    void main() {
        vec2 unpackedUv = getUnpackedUvFromPackedUv(vUv);

        vec4 texel = texture2D(packedDataTex, vUv);

        if (isInBrush(unpackedUv)) {
            // Apply gain to the complex numbers (real and imaginary parts)
            // For mono, this affects .rg. For stereo, it affects all four channels.
            texel *= 2.0;
        }

        gl_FragColor = texel;
    }
  `,
);
