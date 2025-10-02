import { State, useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { OpenFile } from "@renderer/types";
import { ShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import transformBrushFrag from "../glsl/transform-brush.frag";
import { BaseBrush, CommonUniforms, defaultValues } from "./base-brush";

export const boundaryModes = ["smear", "cut", "wrap"] as const;
export type BoundaryMode = (typeof boundaryModes)[number];

class TransformBrush extends BaseBrush {
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
              modulationAmount: 0.0,
            },
          },

          shiftY: {
            value: {
              value: 0.0,
              minValue: -1.0,
              maxValue: 1.0,
              modulationAmount: 0.0,
            },
          },
          scaleX: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmount: 0.0,
            },
          },
          scaleY: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmount: 0.0,
            },
          },
          rotation: {
            value: {
              value: 0.0,
              minValue: -180.0,
              maxValue: 180.0,
              modulationAmount: 0.0,
            },
          },
          boundaryMode: {
            value: 0,
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: transformBrushFrag,
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

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const {
      transformShiftBeats,
      transformShiftSemis,
      transformScaleTime,
      transformScalePitch,
      transformRotation,
      transformEdgeMode,
      filesBpm,
    } = useStore.getState();

    const { file, passIndex } = props;
    const { spectrogramData } = file;
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

    const shiftUv = unitsToUv(
      transformShiftBeats.value,
      transformShiftSemis.value,
      filesBpm[file.filePath],
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
      modulationAmount: transformShiftBeats.modulators?.map((modulationAmount) => modulationAmount.value / 100) || [],
    };
    material.uniforms.shiftY.value = {
      value: shiftUv.y,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmount: transformShiftSemis.modulators?.map((modulationAmount) => modulationAmount.value / 100) || [],
    };
    material.uniforms.scaleX.value = {
      value: transformScaleTime.value,
      minValue: -4,
      maxValue: 4,
      modulationAmount: transformScaleTime.modulators?.map((modulationAmount) => modulationAmount.value / 100) || [],
    };
    material.uniforms.scaleY.value = {
      value: transformScalePitch.value,
      minValue: -4,
      maxValue: 4,
      modulationAmount: transformScalePitch.modulators?.map((modulationAmount) => modulationAmount.value / 100) || [],
    };
    material.uniforms.rotation.value = {
      value: transformRotation.value,
      minValue: -180,
      maxValue: 180,
      modulationAmount: transformRotation.modulators?.map((modulationAmount) => modulationAmount.value / 100) || [],
    };
    material.uniforms.boundaryMode.value = transformEdgeMode.value;
  }
}

export const transformBrush = new TransformBrush();
