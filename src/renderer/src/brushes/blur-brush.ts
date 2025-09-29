import { State, useStore } from "@/store";
import { shaderMaterial } from "@react-three/drei";
import { OpenFile } from "@renderer/types";
import { ShaderMaterial, Vector2 } from "three";
import blurBrushFrag from "../glsl/blur-brush.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { BaseBrush } from "./base-brush";
import { CommonUniforms, defaultValues, unitsToUv } from "./common";

const BlurMaterial = shaderMaterial(
  {
    ...defaultValues,
    blurSizeX: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmount: 0,
    },
    blurSizeY: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmount: 0,
    },
    blurNoiseX: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmount: 0,
    },
    blurNoiseY: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmount: 0,
    },
    blurDirection: new Vector2(1, 0),
    bleed: true,
  },
  passThroughVert,
  blurBrushFrag,
);

class BlurBrush extends BaseBrush {
  materials: ShaderMaterial[];
  parameters: (keyof State)[];

  constructor() {
    super();
    this.materials = [new BlurMaterial(), new BlurMaterial()];
    this.materials[1].uniforms.blurDirection.value = new Vector2(0, 1);
    this.parameters = ["blurAmountTime", "blurAmountPitch", "blurNoiseTime", "blurNoisePitch", "blurBleed"];
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);

    const { file, passIndex } = props;

    const material = this.materials[passIndex];
    if (!material) return;

    const {
      blurAmountTime,
      blurAmountPitch,
      blurAmountTimeMod,
      blurAmountPitchMod,
      blurNoiseTime,
      blurNoisePitch,
      blurNoiseTimeMod,
      blurNoisePitchMod,
      blurBleed,
    } = useStore.getState();
    const { spectrogramData } = file;

    const blurSizeUv = unitsToUv(
      blurAmountTime.value / 100,
      (blurAmountPitch.value / 100) * 12,
      props.commonUniforms.bpm,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    const blurNoiseUv = unitsToUv(
      blurNoiseTime.value / 100,
      (blurNoisePitch.value / 100) * 12,
      props.commonUniforms.bpm,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    material.uniforms.blurSizeX.value = {
      value: blurSizeUv.x,
      minValue: 0,
      maxValue: 0.1,
      modulationAmount: blurAmountTimeMod.value / 100,
    };
    material.uniforms.blurSizeY.value = {
      value: blurSizeUv.y,
      minValue: 0,
      maxValue: 0.1,
      modulationAmount: blurAmountPitchMod.value / 100,
    };
    material.uniforms.blurNoiseX.value = {
      value: blurNoiseUv.x / 10,
      minValue: 0,
      maxValue: 0.1,
      modulationAmount: blurNoiseTimeMod.value / 100,
    };
    material.uniforms.blurNoiseY.value = {
      value: blurNoiseUv.y / 10,
      minValue: 0,
      maxValue: 0.1,
      modulationAmount: blurNoisePitchMod.value / 100,
    };
    material.uniforms.bleed.value = blurBleed.value;
  }
}

export const blurBrush = new BlurBrush();
