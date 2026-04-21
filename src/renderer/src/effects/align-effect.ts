import { GLSL3, RawShaderMaterial } from "three";
import alignFrag from "../glsl/align-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { withPlatformDefines } from "../lib/shader-utils";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

class AlignEffect extends BaseEffect {
  materials: RawShaderMaterial[];

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: { ...defaultValues },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(alignFrag),
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
  }
}

export const alignEffect = new AlignEffect();
