import { ContinuousNumberParameter, OpenFile } from "@renderer/types";
import { DataTexture, FloatType, RedFormat, ShaderMaterial } from "three";
import harmonicsBrushFrag from "../glsl/harmonics-brush.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import { BaseBrush, CommonUniforms, defaultValues } from "./base-brush";

const KERNEL_SIZE = 512;

class HarmonicsBrush extends BaseBrush {
  private harmonicsKernel: DataTexture;
  private lastParams: string;

  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
          harmonicsPower: {
            value: {
              value: 1.0,
              minValue: 0.1,
              maxValue: 4.0,
              modulationAmounts: [],
            },
          },
          harmonicsFalloff: {
            value: {
              value: 10.0,
              minValue: -100,
              maxValue: 100,
              modulationAmounts: [],
            },
          },
          harmonicsOddEven: {
            value: {
              value: 0.0,
              minValue: -100,
              maxValue: 100,
              modulationAmounts: [],
            },
          },
          harmonicsKernel: {
            value: new DataTexture(new Float32Array(KERNEL_SIZE), KERNEL_SIZE, 1, RedFormat, FloatType),
          },
          kernelSize: { value: KERNEL_SIZE },
        },
        vertexShader: passThroughVert,
        fragmentShader: harmonicsBrushFrag,
      }),
    ];

    this.harmonicsKernel = new DataTexture(new Float32Array(KERNEL_SIZE), KERNEL_SIZE, 1, RedFormat, FloatType);
    this.lastParams = "";
  }

  updateKernel(params: { power: number; falloff: number; oddEven: number; bandsPerOctave: number }): boolean {
    const paramsString = JSON.stringify(params);
    if (paramsString === this.lastParams) {
      return false;
    }
    this.lastParams = paramsString;

    const { power, falloff, oddEven, bandsPerOctave } = params;
    const data = new Float32Array(KERNEL_SIZE);
    const oddEvenMix = 0.5 + oddEven / 200;

    // Center pixel is the fundamental
    const center = Math.floor(KERNEL_SIZE / 2);
    data[center] = 1.0;

    for (let h = 2; h < 64; h++) {
      const pixelOffset = Math.round(bandsPerOctave * power * Math.log2(h));
      const harmonicIndex = center - pixelOffset;

      if (harmonicIndex < 0 || harmonicIndex >= KERNEL_SIZE) continue;

      const isEven = h % 2 === 0;
      const oddEvenWeight = isEven ? oddEvenMix : 1.0 - oddEvenMix;
      if (oddEvenWeight < 0.01) continue;

      const amplitude = Math.pow(h, -falloff / 10.0) * oddEvenWeight;
      data[harmonicIndex] += amplitude;
    }

    // Normalize
    let sum = 0;
    for (let i = 0; i < KERNEL_SIZE; i++) {
      sum += data[i];
    }
    if (sum > 0) {
      for (let i = 0; i < KERNEL_SIZE; i++) {
        data[i] /= sum;
      }
    }

    this.harmonicsKernel.image.data = data;
    this.harmonicsKernel.needsUpdate = true;
    return true;
  }

  updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const state = useStore.getState();
    const { harmonicsPower, harmonicsFalloff, harmonicsOddEven } = state;

    const needsUpdate = this.updateKernel({
      power: harmonicsPower.value,
      falloff: harmonicsFalloff.value,
      oddEven: harmonicsOddEven.value,
      bandsPerOctave: props.file.spectrogramData.bandsPerOctave,
    });

    const material = this.materials[props.passIndex];
    if (needsUpdate) {
      material.uniforms.harmonicsKernel.value = this.harmonicsKernel;
    }

    // Set parameter uniforms
    material.uniforms.harmonicsPower.value = {
      value: harmonicsPower.value,
      minValue: harmonicsPower.min,
      maxValue: harmonicsPower.max,
      modulationAmounts:
        harmonicsPower.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.harmonicsFalloff.value = {
      value: harmonicsFalloff.value,
      minValue: harmonicsFalloff.min,
      maxValue: harmonicsFalloff.max,
      modulationAmounts:
        harmonicsFalloff.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
    material.uniforms.harmonicsOddEven.value = {
      value: harmonicsOddEven.value,
      minValue: harmonicsOddEven.min,
      maxValue: harmonicsOddEven.max,
      modulationAmounts:
        harmonicsOddEven.modulatorParamKeys?.map(
          (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
        ) || [],
    };
  }
}

export const harmonicsBrush = new HarmonicsBrush();
