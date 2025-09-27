import { shaderMaterial } from "@react-three/drei";
import { ShaderMaterial } from "three";
import gainBrushFrag from "../glsl/gain-brush.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import { BaseBrush } from "./base-brush";
import { CommonUniforms, defaultValues } from "./common";

type Uniforms = CommonUniforms & {
  gain: number;
};

const GainMaterial = shaderMaterial<Uniforms, ShaderMaterial & Uniforms>(
  {
    ...defaultValues,
    gain: 0.0,
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

  updateUniforms(props: CommonUniforms, passIndex: number): void {
    super.updateUniforms(props, passIndex);
    const { gainDb } = useStore.getState();
    this.materials[passIndex].uniforms.gain.value = Math.pow(10.0, gainDb.value / 20.0);
  }
}

export const gainBrush = new GainBrush();
