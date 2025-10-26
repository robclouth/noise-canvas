import { getNumberParameterDef } from "@renderer/parameters";
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
    const thresholdDbDef = getNumberParameterDef("dynamicsThresholdDb");
    this.materials[props.passIndex].uniforms.thresholdDb.value = {
      value: thresholdDb,
      minValue: thresholdDbDef.min,
      maxValue: thresholdDbDef.max,
      modulationAmounts: thresholdDbDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };

    const upperRatio = state.dynamicsUpperRatio;
    const upperRatioDef = getNumberParameterDef("dynamicsUpperRatio");
    this.materials[props.passIndex].uniforms.upperRatio.value = {
      value: upperRatio,
      minValue: upperRatioDef.min,
      maxValue: upperRatioDef.max,
      modulationAmounts: upperRatioDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };

    const lowerRatio = state.dynamicsLowerRatio;
    const lowerRatioDef = getNumberParameterDef("dynamicsLowerRatio");
    this.materials[props.passIndex].uniforms.lowerRatio.value = {
      value: lowerRatio,
      minValue: lowerRatioDef.min,
      maxValue: lowerRatioDef.max,
      modulationAmounts: lowerRatioDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };

    const knee = state.dynamicsKnee;
    const kneeDef = getNumberParameterDef("dynamicsKnee");
    this.materials[props.passIndex].uniforms.knee.value = {
      value: knee,
      minValue: kneeDef.min,
      maxValue: kneeDef.max,
      modulationAmounts: kneeDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };

    const gainDb = state.dynamicsGainDb;
    const gainDbDef = getNumberParameterDef("dynamicsGainDb");
    this.materials[props.passIndex].uniforms.gainDb.value = {
      value: gainDb,
      minValue: gainDbDef.min,
      maxValue: gainDbDef.max,
      modulationAmounts: gainDbDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };
  }
}

export const dynamicsEffect = new DynamicsEffect();
