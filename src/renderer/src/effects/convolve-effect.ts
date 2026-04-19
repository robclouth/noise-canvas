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
          convolveOrigin: { value: 0 },
          convolveIrTimeOffset: paramUniform(),
          convolveIrPitchOffset: paramUniform(),
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
    // Fall back to painting from self if the IR file isn't loaded
    if (!irOpenFile && irFile) {
      irOpenFile = Object.values(openFiles).find((f) => f.filePath === irFile.path);
    }

    const irTextures = irOpenFile?.rendererRef?.current?.getTextures();
    const irData = irOpenFile?.spectrogramData;
    const enabled = Boolean(irFile && irTextures && irData);

    material.uniforms.convolveIrEnabled.value = enabled;
    if (enabled && irTextures && irData) {
      material.uniforms.convolveIrTex.value = irTextures.packed.texture;
      material.uniforms.convolveIrMetadataTex.value = irTextures.metadata;
      material.uniforms.convolveIrFrameCount.value = irData.numFrames;
      material.uniforms.convolveIrBandCount.value = irData.numBands;
      material.uniforms.convolveIrTextureSize.value = irData.packedTextureSize;
    }

    material.uniforms.convolveIrSize.value = Math.max(1, Math.floor(state.convolveIrSize));
    material.uniforms.convolveOrigin.value = state.convolveOrigin;

    const timeOffsetDef = getNumberParameterDef("convolveIrTimeOffset");
    material.uniforms.convolveIrTimeOffset.value = {
      value: state.convolveIrTimeOffset / 100,
      minValue: timeOffsetDef.min / 100,
      maxValue: timeOffsetDef.max / 100,
      modulationAmounts: getModAmountValuesNormalized(state, "convolveIrTimeOffset"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "convolveIrTimeOffset"),
    };

    const pitchOffsetDef = getNumberParameterDef("convolveIrPitchOffset");
    material.uniforms.convolveIrPitchOffset.value = {
      value: state.convolveIrPitchOffset / 100,
      minValue: pitchOffsetDef.min / 100,
      maxValue: pitchOffsetDef.max / 100,
      modulationAmounts: getModAmountValuesNormalized(state, "convolveIrPitchOffset"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "convolveIrPitchOffset"),
    };

    // Gain: stored as dB, converted to linear here. Min/max as linear so modulation
    // maps smoothly across the dB range.
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
