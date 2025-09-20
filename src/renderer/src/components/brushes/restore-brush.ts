import { shaderMaterial } from "@react-three/drei";
import { ShaderMaterial } from "three";
import { BaseBrush, BrushParameter } from "./base-brush";
import { code, CommonUniforms, defaultValues, vertexShader } from "./common";

const RestoreMaterial = shaderMaterial(
  {
    ...defaultValues,
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
  materials: ShaderMaterial[];
  parameters: BrushParameter[];

  constructor() {
    super();
    this.materials = [new RestoreMaterial()];
    this.parameters = [];
  }

  updateUniforms(props: CommonUniforms, passIndex: number): void {
    super.updateUniforms(props, passIndex);
  }
}

export const restoreBrush = new RestoreBrush();
