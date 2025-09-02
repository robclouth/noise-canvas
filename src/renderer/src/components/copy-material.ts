import { shaderMaterial } from "@react-three/drei";
import * as THREE from "three";

const CopyMaterial = shaderMaterial(
  {
    inputTex: new THREE.Texture(),
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
    uniform sampler2D inputTex;

    void main() {
      gl_FragColor = texture2D(inputTex, vUv);
    }
  `,
);

export const copyMaterial = new CopyMaterial();
