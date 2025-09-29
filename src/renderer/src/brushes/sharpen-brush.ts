import { State, useStore } from "@/store";
import { shaderMaterial } from "@react-three/drei";
import { OpenFile } from "@renderer/types";
import { ShaderMaterial, Vector2 } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import sharpenBrushFrag from "../glsl/sharpen-brush.frag";
import { BaseBrush } from "./base-brush";
import { CommonUniforms, defaultValues, unitsToUv } from "./common";

const SharpenMaterial = shaderMaterial(
  {
    ...defaultValues,
    sharpenAmountX: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmount: 0,
    },
    sharpenAmountY: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmount: 0,
    },
    sharpenDirection: new Vector2(1, 0),
  },
  passThroughVert,
  sharpenBrushFrag,
);

class SharpenBrush extends BaseBrush {
  materials: ShaderMaterial[];
  parameters: (keyof State)[];

  constructor() {
    super();
    this.materials = [new SharpenMaterial(), new SharpenMaterial()];
    this.materials[1].uniforms.sharpenDirection.value = new Vector2(0, 1);
    this.parameters = ["sharpenAmountTime", "sharpenAmountPitch"];
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);

    const { file, passIndex } = props;

    const material = this.materials[passIndex];
    if (!material) return;

    const { sharpenAmountTime, sharpenAmountPitch, sharpenAmountTimeMod, sharpenAmountPitchMod } = useStore.getState();
    const { spectrogramData } = file;

    const sharpenAmountUv = unitsToUv(
      sharpenAmountTime.value / 100,
      (sharpenAmountPitch.value / 100) * 12,
      props.commonUniforms.bpm,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    material.uniforms.sharpenAmountX.value = {
      value: sharpenAmountUv.x,
      minValue: 0,
      maxValue: 0.1,
      modulationAmount: sharpenAmountTimeMod.value / 100,
    };
    material.uniforms.sharpenAmountY.value = {
      value: sharpenAmountUv.y,
      minValue: 0,
      maxValue: 0.1,
      modulationAmount: sharpenAmountPitchMod.value / 100,
    };
  }
}

export const sharpenBrush = new SharpenBrush();
