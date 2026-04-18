import { getNumberParameterDef } from "@renderer/parameters";
import { getContextualModAmountsNormalized, getModAmountValuesNormalized } from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial } from "three";
import transmuteEffectFrag from "../glsl/transmute-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { withPlatformDefines } from "../lib/shader-utils";
import { useStore } from "../store";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

class TransmuteEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...defaultValues,
          transmuteMode: { value: 0 },
          transmuteAmount: {
            value: {
              value: 1.0,
              minValue: -8.0,
              maxValue: 8.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          transmuteCurve: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(transmuteEffectFrag),
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();

    this.materials[0].uniforms.transmuteMode.value = state.transmuteMode;

    const transmuteAmountDef = getNumberParameterDef("transmuteAmount");
    this.materials[0].uniforms.transmuteAmount.value = {
      value: state.transmuteAmount,
      minValue: transmuteAmountDef.min,
      maxValue: transmuteAmountDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "transmuteAmount"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transmuteAmount"),
    };

    const transmuteCurveDef = getNumberParameterDef("transmuteCurve");
    this.materials[0].uniforms.transmuteCurve.value = {
      value: state.transmuteCurve,
      minValue: transmuteCurveDef.min,
      maxValue: transmuteCurveDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "transmuteCurve"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transmuteCurve"),
    };

    // Swap mode places phase values (can be negative) in the magnitude slot.
    // Phase-aware interpolation would log(negative) -> NaN, so opt this one
    // material into linear blend. All other effects keep the proper phase-aware
    // path.
    this.materials[0].uniforms.useLinearBlend.value = state.transmuteMode === 0;
  }
}

export const transmuteEffect = new TransmuteEffect();
