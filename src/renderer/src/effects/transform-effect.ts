import { State, useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { ContinuousNumberParameter, OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import transformEffectFrag from "../glsl/transform-effect.frag";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";

export const boundaryModes = ["smear", "cut", "wrap"] as const;
export type BoundaryMode = (typeof boundaryModes)[number];

class TransformEffect extends BaseEffect {
  materials: ShaderMaterial[];
  parameters: (keyof State)[];

  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
          shiftX: {
            value: {
              value: 0.0,
              minValue: -1.0,
              maxValue: 1.0,
              modulationAmounts: [],
            },
          },

          shiftY: {
            value: {
              value: 0.0,
              minValue: -1.0,
              maxValue: 1.0,
              modulationAmounts: [],
            },
          },
          scaleX: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
            },
          },
          scaleY: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
            },
          },
          rotation: {
            value: {
              value: 0.0,
              minValue: -180.0,
              maxValue: 180.0,
              modulationAmounts: [],
            },
          },
          boundaryMode: {
            value: 0,
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: transformEffectFrag,
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

  updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const state = useStore.getState();
    const {
      transformShiftBeats,
      transformShiftSemis,
      transformScaleTime,
      transformScalePitch,
      transformRotation,
      transformEdgeMode,
      filesBpm,
    } = state;

    const { file, passIndex } = props;
    const { spectrogramData } = file;
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

    const shiftUv = unitsToUv(
      transformShiftBeats.value,
      transformShiftSemis.value,
      filesBpm[file.id],
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
      modulationAmounts:
        transformShiftBeats.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.shiftY.value = {
      value: shiftUv.y,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts:
        transformShiftSemis.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.scaleX.value = {
      value: transformScaleTime.value,
      minValue: -4,
      maxValue: 4,
      modulationAmounts:
        transformScaleTime.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.scaleY.value = {
      value: transformScalePitch.value,
      minValue: -4,
      maxValue: 4,
      modulationAmounts:
        transformScalePitch.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.rotation.value = {
      value: transformRotation.value,
      minValue: -180,
      maxValue: 180,
      modulationAmounts:
        transformRotation.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.boundaryMode.value = transformEdgeMode.value;
  }
}

export const transformEffect = new TransformEffect();
