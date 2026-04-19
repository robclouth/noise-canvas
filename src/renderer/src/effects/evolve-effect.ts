import { getNumberParameterDef } from "@renderer/parameters";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial } from "three";
import evolveEffectFrag from "../glsl/evolve-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { withPlatformDefines } from "../lib/shader-utils";
import { useStore } from "../store";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

const defaultUniformValue = {
  value: 0,
  minValue: -100,
  maxValue: 100,
  modulationAmounts: [] as number[],
  contextualModAmounts: [] as number[],
  macroAmounts: [] as number[],
};

class EvolveEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...defaultValues,
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
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(evolveEffectFrag),
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
      const value = state[stateKey] as number;
      const def = getNumberParameterDef(stateKey);
      material.uniforms[uniformName].value = {
        value,
        minValue: def.min,
        maxValue: def.max,
        modulationAmounts: getModAmountValuesNormalized(state, stateKey),
        contextualModAmounts: getContextualModAmountsNormalized(state, stateKey),
        macroAmounts: getMacroAmountValuesNormalized(state, stateKey),
      };
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
