import { impulseKey } from "@renderer/lib/impulse-key";
import { getNumberParameterDef } from "@renderer/parameters";
import type { SpectrogramData } from "@renderer/store/types";
import { GLSL3, RawShaderMaterial } from "three";
import convolveEffectFrag from "../glsl/convolve-effect.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { useStore } from "../store";
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

// Single scalar that brings the convolution output to roughly unity at 0 dB
// gain, independent of how loud the IR happens to be. Derived from the IR's
// total stored magnitude energy (supplied by the analyzer), so it leaves every
// inter-band and inter-tap ratio (the IR's spectral colour and decay shape)
// untouched — it is purely automatic makeup gain. sqrt(numBands / energy)
// centres the average per-band convolution gain near 1; clamped so a near-silent
// IR can't produce runaway makeup gain.
function getIrNormScale(data: SpectrogramData | undefined): number {
  const energy = data?.magnitudeEnergy;
  if (!data || !energy || energy <= 1e-12 || data.numBands <= 0) return 1;
  return Math.min(Math.sqrt(data.numBands / energy), 1000);
}

const paramUniform = (value = 0, minValue = 0, maxValue = 1) => ({
  value: defaultParameterUniform(value, minValue, maxValue),
});

class ConvolveEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          convolveIrTex: { value: null },
          convolveIrMetadataTex: { value: null },
          convolveIrFrameCount: { value: 0 },
          convolveIrViewStartFrame: { value: 0 },
          convolveIrFileFrameCount: { value: 0 },
          convolveIrBandCount: { value: 0 },
          convolveIrMinFreq: { value: 20 },
          convolveIrBandsPerOctave: { value: 24 },
          convolveIrEnabled: { value: false },
          convolveIrSize: { value: 0 },
          convolveIrTimeOffset: paramUniform(),
          convolveIrPitchShiftSemi: paramUniform(0, -24, 24),
          convolveIrRate: paramUniform(1, -256, 256),
          convolveGainDb: paramUniform(0, -36, 36),
          convolveIrNormScale: { value: 1 },
          convolveEdgeMode: { value: 1 },
        },
        vertexShader: rangeQuadVert,
        fragmentShader: convolveEffectFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const material = this.materials[0];
    if (!material) return;

    // The response is the file the step named, or — with no file named — the
    // file it paints from, read from IR Start of that file either way. Painting
    // a file onto itself collapses the second case to true self-convolution;
    // painting from B onto A gives B ⊛ B, a static response.
    const impulse = props.impulses?.get(impulseKey(state)) ?? null;
    if (impulse) {
      const { spectrogramData: irData, textures, view } = impulse;
      material.uniforms.convolveIrTex.value = textures.packed.texture;
      material.uniforms.convolveIrMetadataTex.value = textures.metadata;
      material.uniforms.convolveIrFrameCount.value = view ? view.endFrame - view.startFrame : irData.numFrames;
      material.uniforms.convolveIrViewStartFrame.value = view ? view.startFrame : 0;
      material.uniforms.convolveIrFileFrameCount.value = irData.numFrames;
      material.uniforms.convolveIrBandCount.value = irData.numBands;
      material.uniforms.convolveIrMinFreq.value = irData.minFreq;
      material.uniforms.convolveIrBandsPerOctave.value = irData.bandsPerOctave;
    } else {
      const sourceFrames = material.uniforms.sourceFrameCount.value;
      material.uniforms.convolveIrTex.value = material.uniforms.sourceSpectrogramTex.value;
      material.uniforms.convolveIrMetadataTex.value = material.uniforms.sourceMetadataTex.value;
      material.uniforms.convolveIrFrameCount.value = sourceFrames;
      material.uniforms.convolveIrViewStartFrame.value = 0;
      material.uniforms.convolveIrFileFrameCount.value = sourceFrames;
      material.uniforms.convolveIrBandCount.value = material.uniforms.sourceBandCount.value;
      material.uniforms.convolveIrMinFreq.value = material.uniforms.sourceMinFreq.value;
      material.uniforms.convolveIrBandsPerOctave.value = material.uniforms.sourceBandsPerOctave.value;
    }
    material.uniforms.convolveIrEnabled.value = true;

    // Normalize against a named response only, so filtering through the file
    // being painted from keeps whatever level that file has.
    material.uniforms.convolveIrNormScale.value =
      state.convolveIrFile && impulse ? getIrNormScale(impulse.spectrogramData) : 1;

    material.uniforms.convolveIrSize.value = Math.max(1, Math.floor(state.convolveIrSize));
    material.uniforms.convolveEdgeMode.value = state.convolveEdgeMode;

    const timeOffsetDef = getNumberParameterDef("convolveIrTimeOffset");
    material.uniforms.convolveIrTimeOffset.value = parameterUniform(state, "convolveIrTimeOffset", props.modContext, {
      value: state.convolveIrTimeOffset / 100,
      min: timeOffsetDef.min / 100,
      max: timeOffsetDef.max / 100,
    });

    material.uniforms.convolveIrPitchShiftSemi.value = parameterUniform(
      state,
      "convolveIrPitchShift",
      props.modContext,
    );

    material.uniforms.convolveIrRate.value = parameterUniform(state, "convolveIrRate", props.modContext);
    material.uniforms.convolveGainDb.value = parameterUniform(state, "convolveGainDb", props.modContext);
  }
}

export const convolveEffect = new ConvolveEffect();
