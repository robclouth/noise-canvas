import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { GLSL3, RawShaderMaterial, Vector2 } from "three";
import blurBrushFrag from "../glsl/blur-effect.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { BaseEffect, createDefaultUniforms, sourceLayout, UpdateEffectUniformsProps } from "./base-effect";

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
    const source = sourceLayout(props.commonUniforms);
    if (!(source.totalDuration > 0) || !(source.numBands > 0)) return;

    // Each control's whole range in the source's UV, so a modulated control
    // sweeps the beats and semitones its slider names, whatever span the
    // source textures hold.
    const toUv = (beats: number, semis: number) =>
      unitsToUv(beats, semis, bpm, source.totalDuration, source.bandsPerOctave, source.numBands);
    const fullSize = toUv(4, 12);
    const fullNoise = toUv(4 / 5, 12 / 5);

    material.uniforms.blurSizeX.value = parameterUniform(state, "blurAmountTime", props.modContext, {
      value: (blurAmountTime / 100) * fullSize.x,
      min: 0,
      max: fullSize.x,
    });
    material.uniforms.blurSizeY.value = parameterUniform(state, "blurAmountPitch", props.modContext, {
      value: (blurAmountPitch / 100) * fullSize.y,
      min: 0,
      max: fullSize.y,
    });
    material.uniforms.blurNoiseX.value = parameterUniform(state, "blurNoiseTime", props.modContext, {
      value: (blurNoiseTime / 100) * fullNoise.x,
      min: 0,
      max: fullNoise.x,
    });
    material.uniforms.blurNoiseY.value = parameterUniform(state, "blurNoisePitch", props.modContext, {
      value: (blurNoisePitch / 100) * fullNoise.y,
      min: 0,
      max: fullNoise.y,
    });
    material.uniforms.blurEdgeMode.value = blurEdgeMode;
    material.uniforms.blurSampleCount.value = passIndex === 0 ? blurSamplesX : blurSamplesY;
    material.uniforms.blurOrigin.value = blurOrigin;
  }
}

export const blurEffect = new BlurEffect();
