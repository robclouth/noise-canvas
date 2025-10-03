import { ContinuousNumberParameter, OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import gainBrushFrag from "../glsl/gain-brush.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import { BaseBrush, CommonUniforms, defaultValues } from "./base-brush";

class GainBrush extends BaseBrush {
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
        fragmentShader: gainBrushFrag,
      }),
    ];
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
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

export const gainBrush = new GainBrush();
