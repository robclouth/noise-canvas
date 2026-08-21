import { getNumberParameterDef } from "@renderer/parameters";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial } from "three";
import transmuteEffectFrag from "../glsl/transmute-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { withPlatformDefines } from "../lib/shader-utils";
import { useStore } from "../store";
import type { State } from "../store/types";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

class TransmuteEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          transmuteMode: { value: 0 },
          transmuteAmount: {
            value: {
              value: 1.0,
              minValue: -8.0,
              maxValue: 8.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },
          transmuteCurve: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(transmuteEffectFrag),
        glslVersion: GLSL3,
      }),
    ];
  }

  togglesDomain(state: State): boolean {
    return state.transmuteMode === 0;
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
      macroAmounts: getMacroAmountValuesNormalized(state, "transmuteAmount"),
    };

    const transmuteCurveDef = getNumberParameterDef("transmuteCurve");
    this.materials[0].uniforms.transmuteCurve.value = {
      value: state.transmuteCurve,
      minValue: transmuteCurveDef.min,
      maxValue: transmuteCurveDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "transmuteCurve"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transmuteCurve"),
      macroAmounts: getMacroAmountValuesNormalized(state, "transmuteCurve"),
    };

    // Swap mode moves the pair into another domain, which only reverses when
    // the blend is an exact linear mix of the whole footprint. All other
    // effects keep the phase-aware, envelope-weighted, step-blended path.
    const isSwap = state.transmuteMode === 0;
    this.materials[0].uniforms.useLinearBlend.value = isSwap;
    this.materials[0].uniforms.bypassBrushWeight.value = isSwap;
    if (isSwap) this.materials[0].uniforms.blendMode.value = 0;
  }
}

export const transmuteEffect = new TransmuteEffect();
