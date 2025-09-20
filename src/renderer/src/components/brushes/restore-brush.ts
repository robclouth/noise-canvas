import { shaderMaterial } from "@react-three/drei";
import { ShaderMaterial } from "three";
import { BaseBrush, BrushParameter } from "./base-brush";
import { brushMain, code, CommonUniforms, defaultValues, vertexShader } from "./common";

const RestoreMaterial = shaderMaterial(
  {
    ...defaultValues,
  },
  vertexShader,
  /*glsl*/ `
    ${code}

    vec4 applyBrushStroke(vec4 sourceTexel, Coords coords) {
      return sampleFromOriginal(coords.dest);
    }

    ${brushMain}
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
