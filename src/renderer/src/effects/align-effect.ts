import { GLSL3, RawShaderMaterial } from "three";
import alignFrag from "../glsl/align-effect.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

class AlignEffect extends BaseEffect {
  materials: RawShaderMaterial[];

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: { ...createDefaultUniforms() },
        vertexShader: rangeQuadVert,
        fragmentShader: alignFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
  }
}

export const alignEffect = new AlignEffect();
