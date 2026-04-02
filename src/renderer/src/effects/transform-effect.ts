import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import type { EffectsState } from "@renderer/store/effects";
import { getContextualModAmountsNormalized, getModAmountValuesNormalized } from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import transformEffectFrag from "../glsl/transform-effect.frag";
import { withPlatformDefines } from "../lib/shader-utils";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

export const boundaryModes = ["smear", "cut", "wrap"] as const;
export type BoundaryMode = (typeof boundaryModes)[number];

class TransformEffect extends BaseEffect {
  materials: RawShaderMaterial[];
  parameters: (keyof EffectsState)[];

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...defaultValues,
          shiftX: {
            value: {
              value: 0.0,
              minValue: -1.0,
              maxValue: 1.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },

          shiftY: {
            value: {
              value: 0.0,
              minValue: -1.0,
              maxValue: 1.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          scaleX: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          scaleY: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          rotation: {
            value: {
              value: 0.0,
              minValue: -180.0,
              maxValue: 180.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          boundaryMode: {
            value: 0,
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(transformEffectFrag),
        glslVersion: GLSL3,
      }),
    ];
    this.parameters = [
      "transformShiftBeats",
      "transformShiftSemis",
      "transformScaleTime",
      "transformScalePitch",
      "transformRotation",
      "transformEdgeMode",
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const {
      transformShiftBeats,
      transformShiftSemis,
      transformScaleTime,
      transformScalePitch,
      transformRotation,
      transformEdgeMode,
      filepathsBpm,
    } = state;

    const { file, passIndex } = props;
    const { spectrogramData } = file;
    if (!spectrogramData) return;
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

    const shiftUv = unitsToUv(
      transformShiftBeats,
      transformShiftSemis,
      filepathsBpm[file.filePath],
      totalDuration,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    const material = this.materials[passIndex];
    if (!material) return;

    material.uniforms.shiftX.value = {
      value: shiftUv.x,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: getModAmountValuesNormalized(state, "transformShiftBeats"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transformShiftBeats"),
    };
    material.uniforms.shiftY.value = {
      value: shiftUv.y,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: getModAmountValuesNormalized(state, "transformShiftSemis"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transformShiftSemis"),
    };
    material.uniforms.scaleX.value = {
      value: transformScaleTime,
      minValue: -4,
      maxValue: 4,
      modulationAmounts: getModAmountValuesNormalized(state, "transformScaleTime"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transformScaleTime"),
    };
    material.uniforms.scaleY.value = {
      value: transformScalePitch,
      minValue: -4,
      maxValue: 4,
      modulationAmounts: getModAmountValuesNormalized(state, "transformScalePitch"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transformScalePitch"),
    };
    material.uniforms.rotation.value = {
      value: transformRotation,
      minValue: -180,
      maxValue: 180,
      modulationAmounts: getModAmountValuesNormalized(state, "transformRotation"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transformRotation"),
    };
    material.uniforms.boundaryMode.value = transformEdgeMode;
  }
}

export const transformEffect = new TransformEffect();
