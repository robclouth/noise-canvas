import { shaderMaterial } from "@react-three/drei";
import { OpenFile } from "@renderer/types";
import { DataTexture, FloatType, RedFormat, ShaderMaterial } from "three";
import harmonicsBrushFrag from "../glsl/harmonics-brush.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import { BaseBrush } from "./base-brush";
import { CommonUniforms, defaultValues, ParameterUniform } from "./common";

const KERNEL_SIZE = 512;

type Uniforms = CommonUniforms & {
  harmonicsPower: ParameterUniform;
  harmonicsFalloff: ParameterUniform;
  harmonicsOddEven: ParameterUniform;
  harmonicsKernel: { value: DataTexture };
  kernelSize: { value: number };
};

const HarmonicsMaterial = shaderMaterial<Uniforms, ShaderMaterial & Uniforms>(
  {
    ...defaultValues,
    harmonicsPower: {
      value: 1.0,
      minValue: 0.1,
      maxValue: 4.0,
      modulationAmount: 0,
    },
    harmonicsFalloff: {
      value: 10.0,
      minValue: -100,
      maxValue: 100,
      modulationAmount: 0,
    },
    harmonicsOddEven: {
      value: 0.0,
      minValue: -100,
      maxValue: 100,
      modulationAmount: 0,
    },
    harmonicsKernel: { value: new DataTexture(new Float32Array(KERNEL_SIZE), KERNEL_SIZE, 1, RedFormat, FloatType) },
    kernelSize: { value: KERNEL_SIZE },
  },
  passThroughVert,
  harmonicsBrushFrag,
);

class HarmonicsBrush extends BaseBrush {
  private harmonicsKernel: DataTexture;
  private lastParams: string;

  constructor() {
    super();
    this.materials = [new HarmonicsMaterial()];
    this.parameters = ["harmonicsPower", "harmonicsFalloff", "harmonicsOddEven"];
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
    const { harmonicsPower, harmonicsFalloff, harmonicsOddEven } = useStore.getState();

    const needsUpdate = this.updateKernel({
      power: harmonicsPower.value,
      falloff: harmonicsFalloff.value,
      oddEven: harmonicsOddEven.value,
      bandsPerOctave: props.file.spectrogramData.bandsPerOctave,
    });

    const material = this.materials[props.passIndex] as Uniforms;
    if (needsUpdate) {
      material.uniforms.harmonicsKernel.value = this.harmonicsKernel;
    }

    // Set simple parameter uniforms
    (material.uniforms.harmonicsPower.value as ParameterUniform).value = harmonicsPower.value;
    (material.uniforms.harmonicsFalloff.value as ParameterUniform).value = harmonicsFalloff.value;
    (material.uniforms.harmonicsOddEven.value as ParameterUniform).value = harmonicsOddEven.value;
  }
}

export const harmonicsBrush = new HarmonicsBrush();
