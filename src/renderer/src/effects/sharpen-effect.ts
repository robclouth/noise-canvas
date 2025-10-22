import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { OpenFile } from "@renderer/store/types";
import { ShaderMaterial, Vector2 } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import sharpenBrushFrag from "../glsl/sharpen-effect.frag";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";

const uniforms = {
  ...defaultValues,
  sharpenAmountX: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmounts: [],
    },
  },
  sharpenAmountY: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmounts: [],
    },
  },
  sharpenDirection: {
    value: new Vector2(1, 0),
  },
};

class SharpenEffect extends BaseEffect {
  materials: ShaderMaterial[];

  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
          ...uniforms,
          sharpenDirection: {
            value: new Vector2(1, 0),
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: sharpenBrushFrag,
      }),
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
          ...uniforms,
          sharpenDirection: {
            value: new Vector2(0, 1),
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: sharpenBrushFrag,
      }),
    ];
  }

  updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);

    const { file, passIndex } = props;

    const material = this.materials[passIndex];
    if (!material) return;

    const state = useStore.getState();
    const { sharpenAmountTime, sharpenAmountPitch } = state;
    const { spectrogramData } = file;

    const sharpenAmountUv = unitsToUv(
      sharpenAmountTime.toNormalized(),
      sharpenAmountPitch.toNormalized() * 12,
      props.commonUniforms.bpm.value,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    material.uniforms.sharpenAmountX.value = {
      value: sharpenAmountUv.x,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: sharpenAmountTime.modulatorParamKeys?.map((paramKey) => state[paramKey].toNormalized()) || [],
    };
    material.uniforms.sharpenAmountY.value = {
      value: sharpenAmountUv.y,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: sharpenAmountPitch.modulatorParamKeys?.map((paramKey) => state[paramKey].toNormalized()) || [],
    };
  }
}

export const sharpenEffect = new SharpenEffect();
