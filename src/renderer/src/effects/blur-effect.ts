import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { GLSL3, RawShaderMaterial, Vector2 } from "three";
import blurBrushFrag from "../glsl/blur-effect.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

function createUniforms() {
  return {
    ...createDefaultUniforms(),
    blurSizeX: { value: defaultParameterUniform(0.01, 0, 100) },
    blurSizeY: { value: defaultParameterUniform(0.01, 0, 100) },
    blurNoiseX: { value: defaultParameterUniform(0.01, 0, 100) },
    blurNoiseY: { value: defaultParameterUniform(0.01, 0, 100) },
    blurDirection: {
      value: new Vector2(1, 0),
    },
    blurEdgeMode: {
      value: 1,
    },
    blurSampleCount: {
      value: 17,
    },
    blurOrigin: {
      value: 0,
    },
  };
}

class BlurEffect extends BaseEffect {
  materials: RawShaderMaterial[];

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createUniforms(),
          blurDirection: {
            value: new Vector2(1, 0),
          },
        },
        vertexShader: rangeQuadVert,
        fragmentShader: blurBrushFrag,
        glslVersion: GLSL3,
      }),
      new RawShaderMaterial({
        uniforms: {
          ...createUniforms(),
          blurDirection: {
            value: new Vector2(0, 1),
          },
        },
        vertexShader: rangeQuadVert,
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
    const {
      blurAmountTime,
      blurAmountPitch,
      blurNoiseTime,
      blurNoisePitch,
      blurEdgeMode,
      blurSamplesX,
      blurSamplesY,
      blurOrigin,
      filepathsBpm,
    } = state;
    const { spectrogramData, filePath } = file;
    if (!spectrogramData) return;

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

    material.uniforms.blurSizeX.value = parameterUniform(state, "blurAmountTime", props.modContext, {
      value: blurSizeUv.x,
      min: 0,
      max: 0.1,
    });
    material.uniforms.blurSizeY.value = parameterUniform(state, "blurAmountPitch", props.modContext, {
      value: blurSizeUv.y,
      min: 0,
      max: 0.1,
    });
    material.uniforms.blurNoiseX.value = parameterUniform(state, "blurNoiseTime", props.modContext, {
      value: blurNoiseUv.x / 5,
      min: 0,
      max: 0.1,
    });
    material.uniforms.blurNoiseY.value = parameterUniform(state, "blurNoisePitch", props.modContext, {
      value: blurNoiseUv.y / 5,
      min: 0,
      max: 0.1,
    });
    material.uniforms.blurEdgeMode.value = blurEdgeMode;
    material.uniforms.blurSampleCount.value = passIndex === 0 ? blurSamplesX : blurSamplesY;
    material.uniforms.blurOrigin.value = blurOrigin;
  }
}

export const blurEffect = new BlurEffect();
