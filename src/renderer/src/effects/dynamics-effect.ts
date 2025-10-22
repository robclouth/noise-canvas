import { OpenFile } from "@renderer/store/types";
import { ShaderMaterial } from "three";
import dynamicsEffectFrag from "../glsl/dynamics-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";

class DynamicsEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
          thresholdDb: {
            value: {
              value: -20.0,
              minValue: -60,
              maxValue: 0,
              modulationAmounts: [],
            },
          },
          upperRatio: {
            value: {
              value: 1.0,
              minValue: -2.0,
              maxValue: 2.0,
              modulationAmounts: [],
            },
          },
          lowerRatio: {
            value: {
              value: 1.0,
              minValue: -2.0,
              maxValue: 2.0,
              modulationAmounts: [],
            },
          },
          knee: {
            value: {
              value: 6.0,
              minValue: 0.0,
              maxValue: 24.0,
              modulationAmounts: [],
            },
          },
          gainDb: {
            value: {
              value: 0.0,
              minValue: -80,
              maxValue: 24,
              modulationAmounts: [],
            },
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: dynamicsEffectFrag,
      }),
    ];
  }

  updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const state = useStore.getState();

    const thresholdDb = state.dynamicsThresholdDb;
    this.materials[props.passIndex].uniforms.thresholdDb.value = {
      value: thresholdDb.value,
      minValue: thresholdDb.min,
      maxValue: thresholdDb.max,
      modulationAmounts: thresholdDb.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
    };

    const upperRatio = state.dynamicsUpperRatio;
    this.materials[props.passIndex].uniforms.upperRatio.value = {
      value: upperRatio.value,
      minValue: upperRatio.min,
      maxValue: upperRatio.max,
      modulationAmounts: upperRatio.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
    };

    const lowerRatio = state.dynamicsLowerRatio;
    this.materials[props.passIndex].uniforms.lowerRatio.value = {
      value: lowerRatio.value,
      minValue: lowerRatio.min,
      maxValue: lowerRatio.max,
      modulationAmounts: lowerRatio.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
    };

    const knee = state.dynamicsKnee;
    this.materials[props.passIndex].uniforms.knee.value = {
      value: knee.value,
      minValue: knee.min,
      maxValue: knee.max,
      modulationAmounts: knee.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
    };

    const gainDb = state.dynamicsGainDb;
    this.materials[props.passIndex].uniforms.gainDb.value = {
      value: gainDb.value,
      minValue: gainDb.min,
      maxValue: gainDb.max,
      modulationAmounts: gainDb.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
    };
  }
}

export const dynamicsEffect = new DynamicsEffect();
