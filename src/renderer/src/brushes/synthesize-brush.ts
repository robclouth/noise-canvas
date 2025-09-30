import { shaderMaterial } from "@react-three/drei";
import { OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import synthesizeBrushFrag from "../glsl/synthesize-brush.frag";
import { useStore } from "../store";
import { BaseBrush } from "./base-brush";
import { CommonUniforms, defaultValues, ParameterUniform } from "./common";

type Uniforms = CommonUniforms & {
  synthesizeType: ParameterUniform;
};

const SynthesizeMaterial = shaderMaterial<Uniforms, ShaderMaterial & Uniforms>(
  {
    ...defaultValues,
    synthesizeType: {
      value: 0.0,
      minValue: 0,
      maxValue: 0,
      modulationAmount: 0,
    },
  },
  passThroughVert,
  synthesizeBrushFrag,
);

class SynthesizeBrush extends BaseBrush {
  constructor() {
    super();
    this.materials = [new SynthesizeMaterial()];
    this.parameters = [];
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const { synthesizeBrushType } = useStore.getState();
    this.materials[props.passIndex].uniforms.synthesizeType.value = {
      value: synthesizeBrushType.value,
      minValue: 0,
      maxValue: synthesizeBrushType.options.length - 1,
      modulationAmount: 0,
    };
  }
}

export const synthesizeBrush = new SynthesizeBrush();
