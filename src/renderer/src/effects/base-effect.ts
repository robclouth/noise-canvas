import { OpenFile, ParameterUniform } from "@renderer/types";
import * as THREE from "three";
import { Texture, Vector2 } from "three";

export type Modulator = {
  modulatorMode: number;
  modulatorPatternShape: number;
  modulatorPhaseMode: number;
  modulatorPatternRateX: ParameterUniform;
  modulatorPatternRateY: ParameterUniform;
  modulatorStrength: ParameterUniform;
  modulatorRotation: ParameterUniform;
  modulatorEnvelopeMinDb: number;
  modulatorEnvelopeMaxDb: number;
};

export type CommonUniforms = {
  sourceSpectrogramTex: { value: Texture };
  sourceInverseMapTex: { value: Texture };
  sourceMetadataTex: { value: Texture };
  sourceFrameCount: { value: number };
  sourceBandCount: { value: number };
  sourceSpectrogramTextureSize: { value: Vector2 };
  sourceChannelCount: { value: number };
  sourceSampleRate: { value: number };
  sourceMinFreq: { value: number };
  sourceBandsPerOctave: { value: number };
  destSpectrogramTex: { value: Texture };
  destInverseMapTex: { value: Texture };
  destMetadataTex: { value: Texture };
  destFrameCount: { value: number };
  destBandCount: { value: number };
  destSpectrogramTextureSize: { value: Vector2 };
  destChannelCount: { value: number };
  destSampleRate: { value: number };
  destMinFreq: { value: number };
  destBandsPerOctave: { value: number };
  originalSpectrogramTex: { value: Texture };
  brushCenterUv: { value: Vector2 };
  brushSizeUv: { value: Vector2 };
  viewZoomPower: { value: number };
  viewOffset: { value: number };
  featherX: { value: number };
  featherY: { value: number };
  featherSlopeTime: { value: number };
  featherSlopePitch: { value: number };
  modulators: { value: Modulator[] };
  brushIntensity: {
    value: ParameterUniform;
  };
  sourceOffsetX: {
    value: number;
  };

  sourceOffsetY: {
    value: number;
  };

  brushPan: {
    value: ParameterUniform;
  };

  bpm: { value: number };
  blendMode: { value: number };
  wrapMode: { value: number };
  algorithm: { value: number };
  gainLut: { value: Texture };
  modulator1ImageTex: { value: Texture };
  modulator2ImageTex: { value: Texture };
  modulator3ImageTex: { value: Texture };
};

export const defaultValues: CommonUniforms = {
  sourceSpectrogramTex: { value: new Texture() },
  sourceInverseMapTex: { value: new Texture() },
  sourceMetadataTex: { value: new Texture() },
  sourceFrameCount: { value: 0 },
  sourceBandCount: { value: 0 },
  sourceSpectrogramTextureSize: { value: new Vector2(0, 0) },
  sourceChannelCount: { value: 1 },
  sourceSampleRate: { value: 44100.0 },
  sourceMinFreq: { value: 20.0 },
  sourceBandsPerOctave: { value: 24.0 },
  destSpectrogramTex: { value: new Texture() },
  destInverseMapTex: { value: new Texture() },
  destMetadataTex: { value: new Texture() },
  destFrameCount: { value: 0 },
  destBandCount: { value: 0 },
  destSpectrogramTextureSize: { value: new Vector2(0, 0) },
  destChannelCount: { value: 1 },
  destSampleRate: { value: 44100.0 },
  destMinFreq: { value: 20.0 },
  destBandsPerOctave: { value: 24.0 },
  originalSpectrogramTex: { value: new Texture() },
  brushCenterUv: { value: new Vector2(0.5, 0.5) },
  brushSizeUv: { value: new Vector2(0.1, 0.1) },
  viewZoomPower: { value: 0.0 },
  viewOffset: { value: 0.0 },
  featherX: { value: 0.5 },
  featherY: { value: 0.5 },
  featherSlopeTime: { value: 0.0 },
  featherSlopePitch: { value: 0.0 },
  brushIntensity: {
    value: {
      value: 1.0,
      minValue: 0.0,
      maxValue: 1.0,
      modulationAmounts: [],
    },
  },
  sourceOffsetX: {
    value: 0,
  },
  sourceOffsetY: {
    value: 0,
  },
  brushPan: {
    value: {
      value: 0.0,
      minValue: 0.0,
      maxValue: 1.0,
      modulationAmounts: [],
    },
  },
  bpm: { value: 120.0 },
  blendMode: { value: 0 },
  wrapMode: { value: 0 },
  algorithm: { value: 0 },
  modulators: { value: [] },
  gainLut: { value: new Texture() },
  modulator1ImageTex: { value: new Texture() },
  modulator2ImageTex: { value: new Texture() },
  modulator3ImageTex: { value: new Texture() },
};

export abstract class BaseEffect {
  materials: THREE.ShaderMaterial[] = [];

  abstract updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void;

  updateCommonUniforms({ commonUniforms, passIndex }: { commonUniforms: CommonUniforms; passIndex: number }): void {
    const material = this.materials[passIndex];
    if (!material) return;

    for (const key in commonUniforms) {
      if (key in material.uniforms) {
        material.uniforms[key].value = commonUniforms[key].value;
      }
    }
  }
}
