import { GLSL3, RawShaderMaterial } from "three";
import waveshapeEffectFrag from "../glsl/waveshape-effect.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { useStore } from "../store";
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

class WaveshapeEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          waveshapeMode: { value: 0 },
          waveshapeDrive: { value: defaultParameterUniform(1.0, 0.01, 16.0) },
          waveshapeTilt: { value: defaultParameterUniform(0.0, -1.0, 1.0) },
        },
        vertexShader: rangeQuadVert,
        fragmentShader: waveshapeEffectFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();

    this.materials[0].uniforms.waveshapeMode.value = state.waveshapeMode;

    this.materials[0].uniforms.waveshapeDrive.value = parameterUniform(state, "waveshapeDrive", props.modContext);

    this.materials[0].uniforms.waveshapeTilt.value = parameterUniform(state, "waveshapeTilt", props.modContext);
  }
}

export const waveshapeEffect = new WaveshapeEffect();
