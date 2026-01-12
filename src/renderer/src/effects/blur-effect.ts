import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { getContextualModAmountsNormalized, getModAmountValuesNormalized } from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial, Vector2 } from "three";
import blurBrushFrag from "../glsl/blur-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

const uniforms = {
  ...defaultValues,
  blurSizeX: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmounts: [],
      contextualModAmounts: [],
    },
  },
  blurSizeY: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmounts: [],
      contextualModAmounts: [],
    },
  },
  blurNoiseX: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmounts: [],
      contextualModAmounts: [],
    },
  },
  blurNoiseY: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmounts: [],
      contextualModAmounts: [],
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
  materials: RawShaderMaterial[];

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...uniforms,
          blurDirection: {
            value: new Vector2(1, 0),
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: blurBrushFrag,
        glslVersion: GLSL3,
      }),
      new RawShaderMaterial({
        uniforms: {
          ...uniforms,
          blurDirection: {
            value: new Vector2(0, 1),
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: blurBrushFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);

    const { file, passIndex } = props;

    const material = this.materials[passIndex];
    if (!material) return;

    const state = props.state ?? useStore.getState();
    const { blurAmountTime, blurAmountPitch, blurNoiseTime, blurNoisePitch, blurBleed, blurOrigin, filepathsBpm } =
      state;
    const { spectrogramData, filePath } = file;

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
      modulationAmounts: getModAmountValuesNormalized(state, "blurAmountTime"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "blurAmountTime"),
    };
    material.uniforms.blurSizeY.value = {
      value: blurSizeUv.y,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: getModAmountValuesNormalized(state, "blurAmountPitch"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "blurAmountPitch"),
    };
    material.uniforms.blurNoiseX.value = {
      value: blurNoiseUv.x / 5,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: getModAmountValuesNormalized(state, "blurNoiseTime"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "blurNoiseTime"),
    };
    material.uniforms.blurNoiseY.value = {
      value: blurNoiseUv.y / 5,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: getModAmountValuesNormalized(state, "blurNoisePitch"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "blurNoisePitch"),
    };
    material.uniforms.bleed.value = blurBleed;
    material.uniforms.blurOrigin.value = blurOrigin;
  }
}

export const blurEffect = new BlurEffect();
