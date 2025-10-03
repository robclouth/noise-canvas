import { OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import synthesizeBrushFrag from "../glsl/synthesize-brush.frag";
import { useStore } from "../store";
import { BaseBrush, CommonUniforms, defaultValues } from "./base-brush";

class SynthesizeBrush extends BaseBrush {
  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
          synthesizeType: { value: 0 },
        },
        vertexShader: passThroughVert,
        fragmentShader: synthesizeBrushFrag,
      }),
    ];
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const state = useStore.getState();
    const { synthesizeBrushType } = state;
    this.materials[props.passIndex].uniforms.synthesizeType.value = synthesizeBrushType.value;
  }
}

export const synthesizeBrush = new SynthesizeBrush();
