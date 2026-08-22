import { GLSL3, RawShaderMaterial } from "three";
import rangeQuadVert from "../glsl/range-quad.vert";
import synthesizeBrushFrag from "../glsl/synthesize-effect.frag";
import { useStore } from "../store";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

class SynthesizeEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          synthesizeType: { value: 0 },
        },
        vertexShader: rangeQuadVert,
        fragmentShader: synthesizeBrushFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const { synthesizeBrushType } = state;
    this.materials[props.passIndex].uniforms.synthesizeType.value = synthesizeBrushType;
  }
}

export const synthesizeEffect = new SynthesizeEffect();
