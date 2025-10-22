import { OpenFile } from "@renderer/store/types";
import { ShaderMaterial } from "three";
import harmonicsBrushFrag from "../glsl/harmonics-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";

class HarmonicsEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
          harmonicsPower: {
            value: {
              value: 1.0,
              minValue: 0.1,
              maxValue: 4.0,
              modulationAmounts: [],
            },
          },
          harmonicsFalloff: {
            value: {
              value: 10.0,
              minValue: 0,
              maxValue: 100,
              modulationAmounts: [],
            },
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: harmonicsBrushFrag,
      }),
    ];
  }

  updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const state = useStore.getState();
    const { harmonicsPower, harmonicsFalloff } = state;

    const material = this.materials[props.passIndex];

    // Set parameter uniforms with modulation support
    material.uniforms.harmonicsPower.value = {
      value: harmonicsPower.value,
      minValue: harmonicsPower.min,
      maxValue: harmonicsPower.max,
      modulationAmounts: harmonicsPower.modulatorParamKeys?.map((paramKey) => state[paramKey].toNormalized()) || [],
    };
    material.uniforms.harmonicsFalloff.value = {
      value: harmonicsFalloff.value,
      minValue: harmonicsFalloff.min,
      maxValue: harmonicsFalloff.max,
      modulationAmounts: harmonicsFalloff.modulatorParamKeys?.map((paramKey) => state[paramKey].toNormalized()) || [],
    };
  }
}

export const harmonicsEffect = new HarmonicsEffect();
