import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { OpenFile } from "@renderer/types";
import { ShaderMaterial, Vector2 } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import sharpenBrushFrag from "../glsl/sharpen-brush.frag";
import { BaseBrush, CommonUniforms, defaultValues } from "./base-brush";

const uniforms = {
  ...defaultValues,
  sharpenAmountX: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmount: 0,
    },
  },
  sharpenAmountY: {
    value: {
      value: 0.01,
      minValue: 0,
      maxValue: 100,
      modulationAmount: 0,
    },
  },
  sharpenDirection: {
    value: new Vector2(1, 0),
  },
};

class SharpenBrush extends BaseBrush {
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

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);

    const { file, passIndex } = props;

    const material = this.materials[passIndex];
    if (!material) return;

    const { sharpenAmountTime, sharpenAmountPitch } = useStore.getState();
    const { spectrogramData } = file;

    const sharpenAmountUv = unitsToUv(
      sharpenAmountTime.value / 100,
      (sharpenAmountPitch.value / 100) * 12,
      props.commonUniforms.bpm.value,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    material.uniforms.sharpenAmountX.value = {
      value: sharpenAmountUv.x,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: sharpenAmountTime.modulators?.map((modulationAmount) => modulationAmount.value / 100) || [],
    };
    material.uniforms.sharpenAmountY.value = {
      value: sharpenAmountUv.y,
      minValue: 0,
      maxValue: 0.1,
      modulationAmounts: sharpenAmountPitch.modulators?.map((modulationAmount) => modulationAmount.value / 100) || [],
    };
  }
}

export const sharpenBrush = new SharpenBrush();
