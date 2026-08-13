import { getNumberParameterDef } from "@renderer/parameters";
import { buildScaleOffsets } from "@renderer/lib/scale-snap";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import type { EffectsState } from "@renderer/store/effects";
import { GLSL3, RawShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import reflowEffectFrag from "../glsl/reflow-effect.frag";
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

class ReflowEffect extends BaseEffect {
  materials: RawShaderMaterial[];
  parameters: (keyof EffectsState)[];

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...defaultValues,
          reflowMode: { value: 0 },
          reflowAmount: { value: { ...defaultUniformValue, value: 100 } },
          reflowPitch: { value: { ...defaultUniformValue, value: -12 } },
          reflowStretch: { value: { ...defaultUniformValue, value: 1 } },
          reflowReach: { value: { ...defaultUniformValue, value: 12 } },
          reflowScaleOffsets: { value: new Float32Array(12) },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(reflowEffectFrag),
        glslVersion: GLSL3,
      }),
    ];
    this.parameters = ["reflowMode", "reflowAmount", "reflowPitch", "reflowStretch", "reflowReach"];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const material = this.materials[props.passIndex];
    if (!material) return;

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

    updateParam("reflowAmount", "reflowAmount");
    updateParam("reflowPitch", "reflowPitch");
    updateParam("reflowStretch", "reflowStretch");
    updateParam("reflowReach", "reflowReach");
    material.uniforms.reflowMode.value = state.reflowMode;
    material.uniforms.reflowScaleOffsets.value = buildScaleOffsets(state.scaleTonic, state.scaleType);
  }
}

export const reflowEffect = new ReflowEffect();
