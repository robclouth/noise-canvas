import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { ContinuousNumberParameter, OpenFile } from "@renderer/types";
import { ShaderMaterial, Vector2 } from "three";
import blurBrushFrag from "../glsl/blur-brush.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { BaseBrush, CommonUniforms, defaultValues } from "./base-brush";

const uniforms = {
  ...defaultValues,
  blurSizeX: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmounts: [],
    },
  },
  blurSizeY: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmounts: [],
    },
  },
  blurNoiseX: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmounts: [],
    },
  },
  blurNoiseY: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmounts: [],
    },
  },
  blurDirection: {
    value: new Vector2(1, 0),
  },
  bleed: {
    value: true,
  },
};

class BlurBrush extends BaseBrush {
  materials: ShaderMaterial[];

  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...uniforms,
          blurDirection: {
            value: new Vector2(1, 0),
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: blurBrushFrag,
      }),
      new ShaderMaterial({
        uniforms: {
          ...uniforms,
          blurDirection: {
            value: new Vector2(0, 1),
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: blurBrushFrag,
      }),
    ];
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);

    const { file, passIndex } = props;

    const material = this.materials[passIndex];
    if (!material) return;

    const state = useStore.getState();
    const { blurAmountTime, blurAmountPitch, blurNoiseTime, blurNoisePitch, blurBleed } = state;
    const { spectrogramData } = file;

    const blurSizeUv = unitsToUv(
      blurAmountTime.value / 100,
      (blurAmountPitch.value / 100) * 12,
      props.commonUniforms.bpm.value,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    const blurNoiseUv = unitsToUv(
      blurNoiseTime.value / 100,
      (blurNoisePitch.value / 100) * 12,
      props.commonUniforms.bpm.value,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    material.uniforms.blurSizeX.value = {
      value: blurSizeUv.x,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts:
        blurAmountTime.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.blurSizeY.value = {
      value: blurSizeUv.y,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts:
        blurAmountPitch.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.blurNoiseX.value = {
      value: blurNoiseUv.x / 5,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts:
        blurNoiseTime.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.blurNoiseY.value = {
      value: blurNoiseUv.y / 5,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts:
        blurNoisePitch.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.bleed.value = blurBleed.value;
  }
}

export const blurBrush = new BlurBrush();
