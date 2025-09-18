import { shaderMaterial } from "@react-three/drei";
import * as THREE from "three";
import { code, uniforms, vertexShader } from "./common";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";

const RestoreMaterial = shaderMaterial(
  {
    ...uniforms,
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    ${code}

    void main() {
        Coords coords = getCoords(vUv);
        vec4 currentTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(coords.dest)) {
            float weight = getFeatherWeight(coords.dest);
            
            vec4 restoredTexel = sampleFromOriginal(coords.dest);

            gl_FragColor = applyBrushEffect(currentTexel, restoredTexel, weight);
        } else {
            gl_FragColor = currentTexel;
        }
    }
  `,
);

class RestoreBrush extends BaseBrush {
  materials: THREE.ShaderMaterial[];
  parameters: BrushParameter[];

  constructor() {
    super();
    this.materials = [new RestoreMaterial()];
    this.parameters = [];
  }

  updateUniforms(props: UpdateUniformsProps, passIndex: number): void {
    super.updateUniforms(props, passIndex);
  }
}

export const restoreBrush = new RestoreBrush();
