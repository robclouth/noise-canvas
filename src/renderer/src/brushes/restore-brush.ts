import { OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import restoreBrushFrag from "../glsl/restore-brush.frag";
import { BaseBrush, CommonUniforms, defaultValues } from "./base-brush";

class RestoreBrush extends BaseBrush {
  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
        },
        vertexShader: passThroughVert,
        fragmentShader: restoreBrushFrag,
      }),
    ];
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
  }
}

export const restoreBrush = new RestoreBrush();
