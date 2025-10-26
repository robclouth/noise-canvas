import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { getNumberParameterDef } from "@renderer/parameters";
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
    const { blurAmountTime, blurAmountPitch, blurNoiseTime, blurNoisePitch, blurBleed, blurOrigin, filepathsBpm } =
      state;
    const { spectrogramData, filePath } = file;

    const blurAmountTimeDef = getNumberParameterDef("blurAmountTime");
    const blurAmountPitchDef = getNumberParameterDef("blurAmountPitch");
    const blurNoiseTimeDef = getNumberParameterDef("blurNoiseTime");
    const blurNoisePitchDef = getNumberParameterDef("blurNoisePitch");

    const bpm = filepathsBpm[filePath] || 120;

    const blurSizeUv = unitsToUv(
      (blurAmountTime * 4) / 100,
      (blurAmountPitch / 100) * 12,
      bpm,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    const blurNoiseUv = unitsToUv(
      (blurNoiseTime * 4) / 100,
      (blurNoisePitch / 100) * 12,
      bpm,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    material.uniforms.blurSizeX.value = {
      value: blurSizeUv.x,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts:
        blurAmountTimeDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };
    material.uniforms.blurSizeY.value = {
      value: blurSizeUv.y,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts:
        blurAmountPitchDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };
    material.uniforms.blurNoiseX.value = {
      value: blurNoiseUv.x / 5,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts:
        blurNoiseTimeDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };
    material.uniforms.blurNoiseY.value = {
      value: blurNoiseUv.y / 5,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts:
        blurNoisePitchDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };
    material.uniforms.bleed.value = blurBleed;
    material.uniforms.blurOrigin.value = blurOrigin;
  }
}

export const blurEffect = new BlurEffect();
