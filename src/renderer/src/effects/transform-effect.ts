import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { getNumberParameterDef } from "@renderer/parameters";
import type { EffectsState } from "@renderer/store/effects";
import { OpenFile } from "@renderer/store/types";
import { ShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import transformEffectFrag from "../glsl/transform-effect.frag";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";

export const boundaryModes = ["smear", "cut", "wrap"] as const;
export type BoundaryMode = (typeof boundaryModes)[number];

class TransformEffect extends BaseEffect {
  materials: ShaderMaterial[];
  parameters: (keyof EffectsState)[];

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
      filepathsBpm,
    } = state;

    const transformShiftBeatsDef = getNumberParameterDef("transformShiftBeats");
    const transformShiftSemisDef = getNumberParameterDef("transformShiftSemis");
    const transformScaleTimeDef = getNumberParameterDef("transformScaleTime");
    const transformScalePitchDef = getNumberParameterDef("transformScalePitch");
    const transformRotationDef = getNumberParameterDef("transformRotation");

    const { file, passIndex } = props;
    const { spectrogramData } = file;
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
      modulationAmounts:
        transformShiftBeatsDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };
    material.uniforms.shiftY.value = {
      value: shiftUv.y,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts:
        transformShiftSemisDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };
    material.uniforms.scaleX.value = {
      value: transformScaleTime,
      minValue: -4,
      maxValue: 4,
      modulationAmounts:
        transformScaleTimeDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };
    material.uniforms.scaleY.value = {
      value: transformScalePitch,
      minValue: -4,
      maxValue: 4,
      modulationAmounts:
        transformScalePitchDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };
    material.uniforms.rotation.value = {
      value: transformRotation,
      minValue: -180,
      maxValue: 180,
      modulationAmounts:
        transformRotationDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
    };
    material.uniforms.boundaryMode.value = transformEdgeMode;
  }
}

export const transformEffect = new TransformEffect();
