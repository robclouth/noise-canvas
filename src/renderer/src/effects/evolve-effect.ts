import { GLSL3, RawShaderMaterial } from "three";
import evolveEffectFrag from "../glsl/evolve-effect.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { useStore } from "../store";
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

const defaultUniformValue = defaultParameterUniform(0, -100, 100);

class EvolveEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          evolveFlow: { value: { ...defaultUniformValue } },
          evolveSpread: { value: { ...defaultUniformValue } },
          evolveGrow: { value: { ...defaultUniformValue } },
          evolveSwirl: { value: { ...defaultUniformValue } },
          evolveDriftX: { value: { ...defaultUniformValue } },
          evolveDriftY: { value: { ...defaultUniformValue } },
          evolveDecay: { value: { ...defaultUniformValue } },
          evolveScaleX: { value: { ...defaultUniformValue, value: 50 } },
          evolveScaleY: { value: { ...defaultUniformValue, value: 50 } },
          evolveEdgeMode: { value: 1 },
        },
        vertexShader: rangeQuadVert,
        fragmentShader: evolveEffectFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const material = this.materials[props.passIndex];

    // Helper to update a parameter uniform
    const updateParam = (uniformName: string, stateKey: keyof typeof state) => {
      material.uniforms[uniformName].value = parameterUniform(state, stateKey, props.modContext);
    };

    updateParam("evolveFlow", "evolveFlow");
    updateParam("evolveSpread", "evolveSpread");
    updateParam("evolveGrow", "evolveGrow");
    updateParam("evolveSwirl", "evolveSwirl");
    updateParam("evolveDriftX", "evolveDriftX");
    updateParam("evolveDriftY", "evolveDriftY");
    updateParam("evolveDecay", "evolveDecay");
    updateParam("evolveScaleX", "evolveScaleX");
    updateParam("evolveScaleY", "evolveScaleY");
    material.uniforms.evolveEdgeMode.value = state.evolveEdgeMode;
  }
}

export const evolveEffect = new EvolveEffect();
