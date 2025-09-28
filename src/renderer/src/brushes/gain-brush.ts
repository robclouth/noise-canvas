import { shaderMaterial } from "@react-three/drei";
import { OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import gainBrushFrag from "../glsl/gain-brush.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import { BaseBrush } from "./base-brush";
import { CommonUniforms, defaultValues, ParameterUniform } from "./common";

type Uniforms = CommonUniforms & {
  gainDb: ParameterUniform;
};

const GainMaterial = shaderMaterial<Uniforms, ShaderMaterial & Uniforms>(
  {
    ...defaultValues,
    gainDb: {
      value: 0.0,
      minValue: -24,
      maxValue: 24,
      modulationAmount: 0,
    },
  },
  passThroughVert,
  gainBrushFrag,
);

class GainBrush extends BaseBrush {
  constructor() {
    super();
    this.materials = [new GainMaterial()];
    this.parameters = ["gainDb"];
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const { gainDb, gainDbMod } = useStore.getState();
    this.materials[props.passIndex].uniforms.gainDb.value = {
      value: gainDb.value,
      minValue: gainDb.min,
      maxValue: gainDb.max,
      modulationAmount: gainDbMod.value / 100,
    };
  }
}

export const gainBrush = new GainBrush();
