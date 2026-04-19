import { getNumberParameterDef } from "@renderer/parameters";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial } from "three";
import waveshapeEffectFrag from "../glsl/waveshape-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { withPlatformDefines } from "../lib/shader-utils";
import { useStore } from "../store";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

class WaveshapeEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...defaultValues,
          waveshapeMode: { value: 0 },
          waveshapeDrive: {
            value: {
              value: 1.0,
              minValue: 0.01,
              maxValue: 16.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },
          waveshapeTilt: {
            value: {
              value: 0.0,
              minValue: -1.0,
              maxValue: 1.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(waveshapeEffectFrag),
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();

    this.materials[0].uniforms.waveshapeMode.value = state.waveshapeMode;

    const driveDef = getNumberParameterDef("waveshapeDrive");
    this.materials[0].uniforms.waveshapeDrive.value = {
      value: state.waveshapeDrive,
      minValue: driveDef.min,
      maxValue: driveDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "waveshapeDrive"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "waveshapeDrive"),
      macroAmounts: getMacroAmountValuesNormalized(state, "waveshapeDrive"),
    };

    const tiltDef = getNumberParameterDef("waveshapeTilt");
    this.materials[0].uniforms.waveshapeTilt.value = {
      value: state.waveshapeTilt,
      minValue: tiltDef.min,
      maxValue: tiltDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "waveshapeTilt"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "waveshapeTilt"),
      macroAmounts: getMacroAmountValuesNormalized(state, "waveshapeTilt"),
    };
  }
}

export const waveshapeEffect = new WaveshapeEffect();
