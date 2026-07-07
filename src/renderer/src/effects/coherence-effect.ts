import { getNumberParameterDef } from "@renderer/parameters";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial, Texture } from "three";
import coherenceFrag from "../glsl/coherence-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { withPlatformDefines } from "../lib/shader-utils";
import { useStore } from "../store";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

// Hillis–Steele time-scan depth. The top band stores one bin per audio sample,
// so real files need far more than 2^16: with fewer passes than log2(bins) the
// scan degrades into a sliding-window sum and sustained tones in the longest
// bands stall to their bin centres (audible as a comb fading in once the
// window fills). 2^26 bins covers the top band of a ~23-minute 48 kHz file.
// Passes whose stride exceeds a band's length are no-ops (the neighbour guard
// in the shader adds nothing). Must stay even: the blend pass samples the
// effect's input FBO (coherenceCanvasTex), which is only feedback-safe while
// blend and seed share ping-pong write parity.
const SCAN_PASSES = 26;

const defaultParam = {
  value: 0,
  minValue: 0,
  maxValue: 100,
  modulationAmounts: [] as number[],
  contextualModAmounts: [] as number[],
  macroAmounts: [] as number[],
};

function makeMaterial(): RawShaderMaterial {
  return new RawShaderMaterial({
    uniforms: {
      ...defaultValues,
      coherencePass: { value: 0 },
      coherenceScanStride: { value: 1 },
      coherenceCanvasTex: { value: null },
      coherenceAmount: { value: { ...defaultParam, value: 100 } },
      coherenceSharpness: { value: { ...defaultParam, value: 50 } },
      coherenceStrictness: { value: { ...defaultParam, value: 40 } },
      coherenceAttack: { value: { ...defaultParam, value: 60 } },
    },
    vertexShader: passThroughVert,
    fragmentShader: withPlatformDefines(coherenceFrag),
    glslVersion: GLSL3,
  });
}

// passIndex -> (coherencePass, stride)
function passConfig(passIndex: number): { pass: number; stride: number } {
  if (passIndex === 0) return { pass: 0, stride: 1 };
  if (passIndex <= SCAN_PASSES) return { pass: 1, stride: 2 ** (passIndex - 1) };
  if (passIndex === SCAN_PASSES + 1) return { pass: 2, stride: 1 };
  return { pass: 3, stride: 1 };
}

class CoherenceEffect extends BaseEffect {
  materials: RawShaderMaterial[];

  // The effect's input texture, captured on pass 0. Later passes see only the
  // previous pass's ping-pong output in destSpectrogramTex, but the blend pass
  // needs the phase the canvas had when this effect started.
  private canvasTex: Texture | null = null;

  constructor() {
    super();
    // seed + SCAN_PASSES scan + lock + blend
    this.materials = Array.from({ length: SCAN_PASSES + 3 }, makeMaterial);
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const material = this.materials[props.passIndex];
    if (!material) return;

    const { pass, stride } = passConfig(props.passIndex);
    material.uniforms.coherencePass.value = pass;
    material.uniforms.coherenceScanStride.value = stride;

    if (props.passIndex === 0) {
      this.canvasTex = props.commonUniforms.destSpectrogramTex.value;
    }
    // Bind the stashed canvas only on the blend pass. The sampler is statically
    // referenced by every pass variant, so binding it while a scan pass renders
    // into that same FBO (which happens whenever this effect is not first in
    // the chain — its input is then a ping-pong temp FBO) forms a WebGL
    // feedback loop and the draw is dropped. The blend pass itself is safe:
    // seed and blend share write parity (SCAN_PASSES is even), so the blend
    // always writes the opposite temp FBO from the effect's input.
    material.uniforms.coherenceCanvasTex.value =
      pass === 3 ? this.canvasTex : props.commonUniforms.originalSpectrogramTex.value;

    const state = props.state ?? useStore.getState();
    const updateParam = (key: "coherenceAmount" | "coherenceSharpness" | "coherenceStrictness" | "coherenceAttack") => {
      const def = getNumberParameterDef(key);
      material.uniforms[key].value = {
        value: state[key],
        minValue: def.min,
        maxValue: def.max,
        modulationAmounts: getModAmountValuesNormalized(state, key),
        contextualModAmounts: getContextualModAmountsNormalized(state, key),
        macroAmounts: getMacroAmountValuesNormalized(state, key),
      };
    };
    updateParam("coherenceAmount");
    updateParam("coherenceSharpness");
    updateParam("coherenceStrictness");
    updateParam("coherenceAttack");
  }
}

export const coherenceEffect = new CoherenceEffect();
