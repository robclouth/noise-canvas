import { shaderMaterial } from "@react-three/drei";
import { OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import restoreBrushFrag from "../glsl/restore-brush.frag";
import { BaseBrush } from "./base-brush";
import { CommonUniforms, defaultValues } from "./common";

type Uniforms = CommonUniforms;

const RestoreMaterial = shaderMaterial<Uniforms, ShaderMaterial & Uniforms>(
  {
    ...defaultValues,
  },
  passThroughVert,
  restoreBrushFrag,
);

class RestoreBrush extends BaseBrush {
  constructor() {
    super();
    this.materials = [new RestoreMaterial()];
    this.parameters = [];
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
  }
}

export const restoreBrush = new RestoreBrush();
