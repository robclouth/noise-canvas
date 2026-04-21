import { getNumberParameterDef } from "@renderer/parameters";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import { getOpenFileByPath, openFiles } from "@renderer/store/files";
import { GLSL3, RawShaderMaterial } from "three";
import convolveEffectFrag from "../glsl/convolve-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { withPlatformDefines } from "../lib/shader-utils";
import { useStore } from "../store";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

const paramUniform = (value = 0, minValue = 0, maxValue = 1) => ({
  value: {
    value,
    minValue,
    maxValue,
    modulationAmounts: [] as number[],
    contextualModAmounts: [] as number[],
  },
});

class ConvolveEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...defaultValues,
          convolveIrTex: { value: null },
          convolveIrMetadataTex: { value: null },
          convolveIrFrameCount: { value: 0 },
          convolveIrBandCount: { value: 0 },
          convolveIrMinFreq: { value: 20 },
          convolveIrBandsPerOctave: { value: 24 },
          convolveIrEnabled: { value: false },
          convolveIrSize: { value: 0 },
          convolveIrTimeOffset: paramUniform(),
          convolveIrPitchShiftSemi: paramUniform(0, -24, 24),
          convolveIrRate: paramUniform(1, -256, 256),
          convolveGain: paramUniform(1, 0, 64),
          convolveEdgeMode: { value: 1 },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(convolveEffectFrag),
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const material = this.materials[0];
    if (!material) return;

    const irFile = state.convolveIrFile;
    let irOpenFile = irFile ? getOpenFileByPath(irFile.path) : undefined;
    if (!irOpenFile && irFile) {
      irOpenFile = Object.values(openFiles).find((f) => f.filePath === irFile.path);
    }

    const irTextures = irOpenFile?.rendererRef?.current?.getTextures();
    const irData = irOpenFile?.spectrogramData;

    // Resolve the IR source. If an explicit IR file was picked and is loaded, use it.
    // Otherwise "Self" — fall back to the source (the file being painted from).
    // updateCommonUniforms ran first, so material.uniforms.source* are populated.
    // Painting a file onto itself collapses this to true self-convolution; painting
    // from B onto A gives B ⊛ B (static IR, predictable). Use a "canvas as filter"
    // workflow by explicitly picking the canvas file as the IR.
    if (irFile && irTextures && irData) {
      material.uniforms.convolveIrTex.value = irTextures.packed.texture;
      material.uniforms.convolveIrMetadataTex.value = irTextures.metadata;
      material.uniforms.convolveIrFrameCount.value = irData.numFrames;
      material.uniforms.convolveIrBandCount.value = irData.numBands;
      material.uniforms.convolveIrMinFreq.value = irData.minFreq;
      material.uniforms.convolveIrBandsPerOctave.value = irData.bandsPerOctave;
      material.uniforms.convolveIrEnabled.value = true;
    } else {
      material.uniforms.convolveIrTex.value = material.uniforms.sourceSpectrogramTex.value;
      material.uniforms.convolveIrMetadataTex.value = material.uniforms.sourceMetadataTex.value;
      material.uniforms.convolveIrFrameCount.value = material.uniforms.sourceFrameCount.value;
      material.uniforms.convolveIrBandCount.value = material.uniforms.sourceBandCount.value;
      material.uniforms.convolveIrMinFreq.value = material.uniforms.sourceMinFreq.value;
      material.uniforms.convolveIrBandsPerOctave.value = material.uniforms.sourceBandsPerOctave.value;
      material.uniforms.convolveIrEnabled.value = true;
    }

    material.uniforms.convolveIrSize.value = Math.max(1, Math.floor(state.convolveIrSize));
    material.uniforms.convolveEdgeMode.value = state.convolveEdgeMode;

    const timeOffsetDef = getNumberParameterDef("convolveIrTimeOffset");
    material.uniforms.convolveIrTimeOffset.value = {
      value: state.convolveIrTimeOffset / 100,
      minValue: timeOffsetDef.min / 100,
      maxValue: timeOffsetDef.max / 100,
      modulationAmounts: getModAmountValuesNormalized(state, "convolveIrTimeOffset"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "convolveIrTimeOffset"),
      macroAmounts: getMacroAmountValuesNormalized(state, "convolveIrTimeOffset"),
    };

    const pitchShiftDef = getNumberParameterDef("convolveIrPitchShift");
    material.uniforms.convolveIrPitchShiftSemi.value = {
      value: state.convolveIrPitchShift,
      minValue: pitchShiftDef.min,
      maxValue: pitchShiftDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "convolveIrPitchShift"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "convolveIrPitchShift"),
      macroAmounts: getMacroAmountValuesNormalized(state, "convolveIrPitchShift"),
    };

    const rateDef = getNumberParameterDef("convolveIrRate");
    material.uniforms.convolveIrRate.value = {
      value: state.convolveIrRate,
      minValue: rateDef.min,
      maxValue: rateDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "convolveIrRate"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "convolveIrRate"),
      macroAmounts: getMacroAmountValuesNormalized(state, "convolveIrRate"),
    };

    const gainDef = getNumberParameterDef("convolveGainDb");
    const dbToLinear = (db: number) => Math.pow(10, db / 20);
    material.uniforms.convolveGain.value = {
      value: dbToLinear(state.convolveGainDb),
      minValue: dbToLinear(gainDef.min),
      maxValue: dbToLinear(gainDef.max),
      modulationAmounts: getModAmountValuesNormalized(state, "convolveGainDb"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "convolveGainDb"),
      macroAmounts: getMacroAmountValuesNormalized(state, "convolveGainDb"),
    };
  }
}

export const convolveEffect = new ConvolveEffect();
