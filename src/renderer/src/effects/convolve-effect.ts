import { getNumberParameterDef } from "@renderer/parameters";
import { getContextualModAmountsNormalized, getModAmountValuesNormalized } from "@renderer/store/modulators";
import { getOpenFileByPath, openFiles } from "@renderer/store/files";
import { GLSL3, RawShaderMaterial, Vector2 } from "three";
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
          convolveIrTextureSize: { value: new Vector2(0, 0) },
          convolveIrEnabled: { value: false },
          convolveIrSize: { value: 0 },
          convolveIrTimeOffset: paramUniform(),
          // Pitch shift in IR-band-local units (bands, can be fractional).
          // Converted from semitones in TS using the IR's bandsPerOctave.
          convolveIrPitchShiftBands: paramUniform(0, -256, 256),
          convolveIrRate: paramUniform(1, -256, 256),
          convolveGain: paramUniform(1, 0, 64),
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
    // Otherwise "Self" — use the current dest (canvas) as the IR. updateCommonUniforms
    // ran first, so material.uniforms.dest* hold the dest textures/metadata for this pass.
    let bandsPerOctaveForPitchShift: number;
    if (irFile && irTextures && irData) {
      material.uniforms.convolveIrTex.value = irTextures.packed.texture;
      material.uniforms.convolveIrMetadataTex.value = irTextures.metadata;
      material.uniforms.convolveIrFrameCount.value = irData.numFrames;
      material.uniforms.convolveIrBandCount.value = irData.numBands;
      material.uniforms.convolveIrTextureSize.value = irData.packedTextureSize;
      material.uniforms.convolveIrEnabled.value = true;
      bandsPerOctaveForPitchShift = irData.bandsPerOctave;
    } else {
      // Self-convolution: dest texture doubles as the IR.
      material.uniforms.convolveIrTex.value = material.uniforms.destSpectrogramTex.value;
      material.uniforms.convolveIrMetadataTex.value = material.uniforms.destMetadataTex.value;
      material.uniforms.convolveIrFrameCount.value = material.uniforms.destFrameCount.value;
      material.uniforms.convolveIrBandCount.value = material.uniforms.destBandCount.value;
      material.uniforms.convolveIrTextureSize.value = material.uniforms.destSpectrogramTextureSize.value;
      material.uniforms.convolveIrEnabled.value = true;
      bandsPerOctaveForPitchShift = material.uniforms.destBandsPerOctave.value as number;
    }

    material.uniforms.convolveIrSize.value = Math.max(1, Math.floor(state.convolveIrSize));

    const timeOffsetDef = getNumberParameterDef("convolveIrTimeOffset");
    material.uniforms.convolveIrTimeOffset.value = {
      value: state.convolveIrTimeOffset / 100,
      minValue: timeOffsetDef.min / 100,
      maxValue: timeOffsetDef.max / 100,
      modulationAmounts: getModAmountValuesNormalized(state, "convolveIrTimeOffset"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "convolveIrTimeOffset"),
    };

    // Semitones → IR bands (delta). Twelve semitones = one octave = `bandsPerOctave` bands.
    // Stored in IR-band units so the shader can just add it to the IR band index.
    const pitchShiftDef = getNumberParameterDef("convolveIrPitchShift");
    const bandsPerSemi = bandsPerOctaveForPitchShift / 12;
    material.uniforms.convolveIrPitchShiftBands.value = {
      value: state.convolveIrPitchShift * bandsPerSemi,
      minValue: pitchShiftDef.min * bandsPerSemi,
      maxValue: pitchShiftDef.max * bandsPerSemi,
      modulationAmounts: getModAmountValuesNormalized(state, "convolveIrPitchShift"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "convolveIrPitchShift"),
    };

    const rateDef = getNumberParameterDef("convolveIrRate");
    material.uniforms.convolveIrRate.value = {
      value: state.convolveIrRate,
      minValue: rateDef.min,
      maxValue: rateDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "convolveIrRate"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "convolveIrRate"),
    };

    const gainDef = getNumberParameterDef("convolveGainDb");
    const dbToLinear = (db: number) => Math.pow(10, db / 20);
    material.uniforms.convolveGain.value = {
      value: dbToLinear(state.convolveGainDb),
      minValue: dbToLinear(gainDef.min),
      maxValue: dbToLinear(gainDef.max),
      modulationAmounts: getModAmountValuesNormalized(state, "convolveGainDb"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "convolveGainDb"),
    };
  }
}

export const convolveEffect = new ConvolveEffect();
