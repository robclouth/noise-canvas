import { State, useStore } from "@/store";
import { shaderMaterial } from "@react-three/drei";
import { OpenFile } from "@renderer/types";
import { ShaderMaterial, Vector2 } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import transformBrushFrag from "../glsl/transform-brush.frag";
import { BaseBrush } from "./base-brush";
import { CommonUniforms, defaultValues, unitsToUv } from "./common";

export const boundaryModes = ["smear", "cut", "wrap"] as const;
export type BoundaryMode = (typeof boundaryModes)[number];

const TransformMaterial = shaderMaterial(
  {
    ...defaultValues,
    shiftUv: new Vector2(0.0, 0.0),
    scale: new Vector2(1.0, 1.0),
    rotation: 0.0,
    boundaryMode: 0,
  },
  passThroughVert,
  transformBrushFrag,
);

class TransformBrush extends BaseBrush {
  materials: ShaderMaterial[];
  parameters: (keyof State)[];

  constructor() {
    super();
    this.materials = [new TransformMaterial()];
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

    material.uniforms.shiftUv.value.copy(shiftUv);
    material.uniforms.scale.value.set(transformScaleTime.value, transformScalePitch.value);
    material.uniforms.rotation.value = transformRotation.value;
    material.uniforms.boundaryMode.value = transformEdgeMode.value;
  }
}

export const transformBrush = new TransformBrush();
