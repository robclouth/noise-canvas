import { getNumberParameterDef } from "@renderer/parameters";
import { buildScaleOffsets } from "@renderer/lib/scale-snap";
import { ONSETS_GRID_VALUE } from "@renderer/lib/constants";
import { unitsToUv } from "@renderer/lib/utils";
import { getOpenFileByPath, openFiles } from "@renderer/store/files";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import type { EffectsState } from "@renderer/store/effects";
import { GLSL3, RawShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import attractEffectFrag from "../glsl/attract-effect.frag";
import { withPlatformDefines } from "../lib/shader-utils";
import { useStore } from "../store";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

const defaultUniformValue = {
  value: 0,
  minValue: -100,
  maxValue: 100,
  modulationAmounts: [] as number[],
  contextualModAmounts: [] as number[],
  macroAmounts: [] as number[],
};

// Pass layout: [pitch axis, time axis]
const PASS_AXES = [0, 1];

class AttractEffect extends BaseEffect {
  materials: RawShaderMaterial[];
  parameters: (keyof EffectsState)[];

  constructor() {
    super();
    this.materials = PASS_AXES.map(
      (axis) =>
        new RawShaderMaterial({
          uniforms: {
            ...defaultValues,
            attractMap: { value: 0 },
            attractKernel: { value: 0 },
            attractAxis: { value: axis },
            attractAmountX: { value: { ...defaultUniformValue } },
            attractAmountY: { value: { ...defaultUniformValue, value: 100 } },
            attractSmoothX: { value: { ...defaultUniformValue, value: 0.25 } },
            attractSmoothY: { value: { ...defaultUniformValue, value: 1 } },
            attractScaleOffsets: { value: new Float32Array(12) },
            attractGridSemis: { value: 0 },
            attractGridBeats: { value: 1 },
            attractUvPerBeat: { value: 0 },
            attractFieldMode: { value: 0 },
            attractFieldTex: { value: null },
            attractFieldMetaTex: { value: null },
            attractFieldFrames: { value: 1 },
            attractFieldBands: { value: 1 },
            attractFieldMinFreq: { value: 20 },
            attractFieldBpo: { value: 12 },
          },
          vertexShader: passThroughVert,
          fragmentShader: withPlatformDefines(attractEffectFrag),
          glslVersion: GLSL3,
        }),
    );
    this.parameters = [
      "attractMap",
      "attractAmountX",
      "attractAmountY",
      "attractSmoothX",
      "attractSmoothY",
      "attractKernel",
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const material = this.materials[props.passIndex];
    if (!material) return;

    const updateParam = (uniformName: string, stateKey: keyof typeof state) => {
      const value = state[stateKey] as number;
      const def = getNumberParameterDef(stateKey);
      material.uniforms[uniformName].value = {
        value,
        minValue: def.min,
        maxValue: def.max,
        modulationAmounts: getModAmountValuesNormalized(state, stateKey),
        contextualModAmounts: getContextualModAmountsNormalized(state, stateKey),
        macroAmounts: getMacroAmountValuesNormalized(state, stateKey),
      };
    };

    updateParam("attractAmountX", "attractAmountX");
    updateParam("attractAmountY", "attractAmountY");
    updateParam("attractSmoothX", "attractSmoothX");
    updateParam("attractSmoothY", "attractSmoothY");
    material.uniforms.attractMap.value = state.attractMap;
    material.uniforms.attractKernel.value = state.attractKernel;
    material.uniforms.attractScaleOffsets.value = buildScaleOffsets(state.scaleTonic, state.scaleType);
    material.uniforms.attractGridSemis.value = state.gridSizeSemis;
    material.uniforms.attractGridBeats.value = state.gridSizeBeats > ONSETS_GRID_VALUE ? state.gridSizeBeats : 1;

    // Source map field: a picked, loaded file supplies the landscape, matched
    // by absolute frequency. In self mode the shader reads the canvas
    // directly; the fallback bindings only keep the samplers valid.
    const fieldFile = state.attractSourceFile;
    let fieldOpenFile = fieldFile ? getOpenFileByPath(fieldFile.path) : undefined;
    if (!fieldOpenFile && fieldFile) {
      fieldOpenFile = Object.values(openFiles).find((f) => f.filePath === fieldFile.path);
    }
    const fieldTextures = fieldOpenFile?.rendererRef?.current?.getTextures();
    const fieldData = fieldOpenFile?.spectrogramData;
    if (fieldFile && fieldTextures && fieldData) {
      material.uniforms.attractFieldMode.value = 1;
      material.uniforms.attractFieldTex.value = fieldTextures.packed.texture;
      material.uniforms.attractFieldMetaTex.value = fieldTextures.metadata;
      material.uniforms.attractFieldFrames.value = fieldData.numFrames;
      material.uniforms.attractFieldBands.value = fieldData.numBands;
      material.uniforms.attractFieldMinFreq.value = fieldData.minFreq;
      material.uniforms.attractFieldBpo.value = fieldData.bandsPerOctave;
    } else {
      material.uniforms.attractFieldMode.value = 0;
      material.uniforms.attractFieldTex.value = material.uniforms.destSpectrogramTex.value;
      material.uniforms.attractFieldMetaTex.value = material.uniforms.destMetadataTex.value;
      material.uniforms.attractFieldFrames.value = material.uniforms.destFrameCount.value;
      material.uniforms.attractFieldBands.value = material.uniforms.destBandCount.value;
      material.uniforms.attractFieldMinFreq.value = material.uniforms.destMinFreq.value;
      material.uniforms.attractFieldBpo.value = material.uniforms.destBandsPerOctave.value;
    }

    const { file } = props;
    const { spectrogramData } = file;
    if (spectrogramData) {
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const bpm = state.filepathsBpm[file.filePath] ?? 120;
      material.uniforms.attractUvPerBeat.value = unitsToUv(
        1,
        0,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      ).x;
    }
  }
}

export const attractEffect = new AttractEffect();
