import { OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import passthroughFrag from "../glsl/passthrough-effect.frag";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";

/**
 * A passthrough effect that just copies the source to the destination
 * while properly handling metadata conversion between different spectrogram layouts.
 */
class PassthroughEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
        },
        vertexShader: passThroughVert,
        fragmentShader: passthroughFrag,
      }),
    ];
  }

  updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
  }
}

export const passThroughEffect = new PassthroughEffect();
