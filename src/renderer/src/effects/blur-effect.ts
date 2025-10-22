import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { OpenFile } from "@renderer/store/types";
import { ShaderMaterial, Vector2 } from "three";
import blurBrushFrag from "../glsl/blur-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";

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
  blurOrigin: {
    value: 0,
  },
};

class BlurEffect extends BaseEffect {
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

  updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);

    const { file, passIndex } = props;

    const material = this.materials[passIndex];
    if (!material) return;

    const state = useStore.getState();
    const { blurAmountTime, blurAmountPitch, blurNoiseTime, blurNoisePitch, blurBleed, blurOrigin } = state;
    const { spectrogramData } = file;

    const blurSizeUv = unitsToUv(
      blurAmountTime.toNormalized(),
      blurAmountPitch.toNormalized() * 12,
      props.commonUniforms.bpm.value,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    const blurNoiseUv = unitsToUv(
      blurNoiseTime.toNormalized(),
      blurNoisePitch.toNormalized() * 12,
      props.commonUniforms.bpm.value,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    material.uniforms.blurSizeX.value = {
      value: blurSizeUv.x,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: blurAmountTime.modulatorParamKeys?.map((paramKey) => state[paramKey].toNormalized()) || [],
    };
    material.uniforms.blurSizeY.value = {
      value: blurSizeUv.y,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: blurAmountPitch.modulatorParamKeys?.map((paramKey) => state[paramKey].toNormalized()) || [],
    };
    material.uniforms.blurNoiseX.value = {
      value: blurNoiseUv.x / 5,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: blurNoiseTime.modulatorParamKeys?.map((paramKey) => state[paramKey].toNormalized()) || [],
    };
    material.uniforms.blurNoiseY.value = {
      value: blurNoiseUv.y / 5,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: blurNoisePitch.modulatorParamKeys?.map((paramKey) => state[paramKey].toNormalized()) || [],
    };
    material.uniforms.bleed.value = blurBleed.value;
    material.uniforms.blurOrigin.value = blurOrigin.value;
  }
}

export const blurEffect = new BlurEffect();
