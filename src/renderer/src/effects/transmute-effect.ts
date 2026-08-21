import { getNumberParameterDef } from "@renderer/parameters";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial } from "three";
import transmuteEffectFrag from "../glsl/transmute-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import type { State } from "../store/types";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

const PART_MAG = 0;
const PART_PHASE = 1;

/** Phase → Magnitude carries the pair out of magnitude and phase; Magnitude → Phase brings it back. */
function opensSwap(state: State): boolean {
  return state.transmuteFrom === PART_PHASE && state.transmuteTo === PART_MAG;
}
function closesSwap(state: State): boolean {
  return state.transmuteFrom === PART_MAG && state.transmuteTo === PART_PHASE;
}

class TransmuteEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          transmuteFrom: { value: 1 },
          transmuteTo: { value: 0 },
          transmuteBeatsToUv: { value: 0 },
          transmuteAmount: {
            value: {
              value: 1.0,
              minValue: -8.0,
              maxValue: 8.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },
          transmuteCurve: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: transmuteEffectFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  domainAfter(state: State, inSwappedDomain: boolean): boolean {
    if (opensSwap(state)) return true;
    if (closesSwap(state)) return false;
    return inSwappedDomain;
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();

    this.materials[0].uniforms.transmuteFrom.value = state.transmuteFrom;
    this.materials[0].uniforms.transmuteTo.value = state.transmuteTo;

    const { spectrogramData, filePath } = props.file;
    const bpm = state.filepathsBpm[filePath] || 120;
    const totalDuration = spectrogramData ? spectrogramData.numFrames / spectrogramData.sampleRate : 0;
    this.materials[0].uniforms.transmuteBeatsToUv.value = 60 / bpm / (totalDuration > 0 ? totalDuration : 1);

    const transmuteAmountDef = getNumberParameterDef("transmuteAmount");
    this.materials[0].uniforms.transmuteAmount.value = {
      value: state.transmuteAmount,
      minValue: transmuteAmountDef.min,
      maxValue: transmuteAmountDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "transmuteAmount"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transmuteAmount"),
      macroAmounts: getMacroAmountValuesNormalized(state, "transmuteAmount"),
    };

    const transmuteCurveDef = getNumberParameterDef("transmuteCurve");
    this.materials[0].uniforms.transmuteCurve.value = {
      value: state.transmuteCurve,
      minValue: transmuteCurveDef.min,
      maxValue: transmuteCurveDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "transmuteCurve"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transmuteCurve"),
      macroAmounts: getMacroAmountValuesNormalized(state, "transmuteCurve"),
    };

    // The two routes that move the pair between domains only reverse when the
    // blend is an exact linear mix of the whole footprint. Every other route,
    // and every other effect, keeps the phase-aware, envelope-weighted,
    // step-blended path.
    const movesDomain = opensSwap(state) || closesSwap(state);
    this.materials[0].uniforms.useLinearBlend.value = movesDomain;
    this.materials[0].uniforms.bypassBrushWeight.value = movesDomain;
    if (movesDomain) this.materials[0].uniforms.blendMode.value = 0;
  }
}

export const transmuteEffect = new TransmuteEffect();
