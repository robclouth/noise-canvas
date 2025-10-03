import { ContinuousNumberParameter, OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import { useStore } from "../store";
import { BaseBrush, CommonUniforms, defaultValues } from "./base-brush";

class SynthesizeBrush extends BaseBrush {
  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
          synthesizeType: {
            value: {
              value: 0.0,
              minValue: 0,
              maxValue: 0,
              modulationAmounts: [],
            },
          },
        },
      }),
    ];
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const state = useStore.getState();
    const { synthesizeBrushType } = state;
    this.materials[props.passIndex].uniforms.synthesizeType.value = {
      value: synthesizeBrushType.value,
      minValue: 0,
      maxValue: synthesizeBrushType.options.length - 1,
      modulationAmounts:
        synthesizeBrushType.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
  }
}

export const synthesizeBrush = new SynthesizeBrush();
