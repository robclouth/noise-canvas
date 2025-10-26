import { OpenFile } from "@renderer/store/types";
import { ShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import synthesizeBrushFrag from "../glsl/synthesize-effect.frag";
import { useStore } from "../store";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";

class SynthesizeEffect extends BaseEffect {
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

  updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const state = useStore.getState();
    const { synthesizeBrushType } = state;
    this.materials[props.passIndex].uniforms.synthesizeType.value = synthesizeBrushType;
  }
}

export const synthesizeEffect = new SynthesizeEffect();
