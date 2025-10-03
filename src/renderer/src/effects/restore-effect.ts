import { OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import restoreBrushFrag from "../glsl/restore-effect.frag";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";

class RestoreEffect extends BaseEffect {
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

  updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
  }
}

export const restoreEffect = new RestoreEffect();
