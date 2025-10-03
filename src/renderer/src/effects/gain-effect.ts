import { ContinuousNumberParameter, OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import gainEffectFrag from "../glsl/gain-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";

class GainEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
          gainDb: {
            value: {
              value: 0.0,
              minValue: -24,
              maxValue: 24,
              modulationAmounts: [],
            },
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: gainEffectFrag,
      }),
    ];
  }

  updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const state = useStore.getState();
    const gainDb = state.gainDb;
    this.materials[props.passIndex].uniforms.gainDb.value = {
      value: gainDb.value,
      minValue: gainDb.min,
      maxValue: gainDb.max,
      modulationAmounts:
        gainDb.modulatorParamKeys?.map((paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100) || [],
    };
  }
}

export const gainEffect = new GainEffect();
