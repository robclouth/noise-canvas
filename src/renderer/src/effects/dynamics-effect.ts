import { getNumberParameterDef } from "@renderer/parameters";
import { getContextualModAmountsNormalized, getModAmountValuesNormalized } from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial } from "three";
import dynamicsEffectFrag from "../glsl/dynamics-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { withPlatformDefines } from "../lib/shader-utils";
import { useStore } from "../store";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

class DynamicsEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...defaultValues,
          thresholdDb: {
            value: {
              value: -20.0,
              minValue: -60,
              maxValue: 0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          upperRatio: {
            value: {
              value: 1.0,
              minValue: -2.0,
              maxValue: 2.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          lowerRatio: {
            value: {
              value: 1.0,
              minValue: -2.0,
              maxValue: 2.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          knee: {
            value: {
              value: 6.0,
              minValue: 0.0,
              maxValue: 24.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          gainDb: {
            value: {
              value: 0.0,
              minValue: -80,
              maxValue: 24,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(dynamicsEffectFrag),
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();

    const thresholdDb = state.dynamicsThresholdDb;
    const thresholdDbDef = getNumberParameterDef("dynamicsThresholdDb");
    this.materials[props.passIndex].uniforms.thresholdDb.value = {
      value: thresholdDb,
      minValue: thresholdDbDef.min,
      maxValue: thresholdDbDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "dynamicsThresholdDb"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "dynamicsThresholdDb"),
    };

    const upperRatio = state.dynamicsUpperRatio;
    const upperRatioDef = getNumberParameterDef("dynamicsUpperRatio");
    this.materials[props.passIndex].uniforms.upperRatio.value = {
      value: upperRatio,
      minValue: upperRatioDef.min,
      maxValue: upperRatioDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "dynamicsUpperRatio"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "dynamicsUpperRatio"),
    };

    const lowerRatio = state.dynamicsLowerRatio;
    const lowerRatioDef = getNumberParameterDef("dynamicsLowerRatio");
    this.materials[props.passIndex].uniforms.lowerRatio.value = {
      value: lowerRatio,
      minValue: lowerRatioDef.min,
      maxValue: lowerRatioDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "dynamicsLowerRatio"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "dynamicsLowerRatio"),
    };

    const knee = state.dynamicsKnee;
    const kneeDef = getNumberParameterDef("dynamicsKnee");
    this.materials[props.passIndex].uniforms.knee.value = {
      value: knee,
      minValue: kneeDef.min,
      maxValue: kneeDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "dynamicsKnee"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "dynamicsKnee"),
    };

    const gainDb = state.dynamicsGainDb;
    const gainDbDef = getNumberParameterDef("dynamicsGainDb");
    this.materials[props.passIndex].uniforms.gainDb.value = {
      value: gainDb,
      minValue: gainDbDef.min,
      maxValue: gainDbDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "dynamicsGainDb"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "dynamicsGainDb"),
    };
  }
}

export const dynamicsEffect = new DynamicsEffect();
