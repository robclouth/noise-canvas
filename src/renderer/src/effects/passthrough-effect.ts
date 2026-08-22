import { GLSL3, RawShaderMaterial } from "three";
import rangeQuadVert from "../glsl/range-quad.vert";
import passthroughFrag from "../glsl/passthrough-effect.frag";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

/**
 * A passthrough effect that just copies the source to the destination
 * while properly handling metadata conversion between different spectrogram layouts.
 */
class PassthroughEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
        },
        vertexShader: rangeQuadVert,
        fragmentShader: passthroughFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
  }
}

export const passThroughEffect = new PassthroughEffect();
