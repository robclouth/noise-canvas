import { GLSL3, RawShaderMaterial } from "three";
import neuralEffectFrag from "../glsl/neural-effect.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { useStore } from "../store";
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { unitsToUv } from "@renderer/lib/utils";
import type { State } from "@renderer/store/types";
import { BaseEffect, createDefaultUniforms, destinationLayout, UpdateEffectUniformsProps } from "./base-effect";
import { NEURAL_HIDDEN, NEURAL_INPUTS, NEURAL_MAX_GENERATIONS, NEURAL_OUTPUTS, neuralWeights } from "./neural-weights";

const defaultUniformValue = defaultParameterUniform(0, 0, 100);

/** How many generations the settings ask for, inside what the effect can run. */
export function neuralGenerationCount(state: State): number {
  const requested = Math.round(state.neuralGenerations);
  return Math.min(NEURAL_MAX_GENERATIONS, Math.max(1, Number.isFinite(requested) ? requested : 1));
}

class NeuralEffect extends BaseEffect {
  materials: RawShaderMaterial[];

  constructor() {
    super();
    // One material per generation. They share a shader, so three.js compiles
    // it once, and each keeps its own uniforms while the chain renders.
    this.materials = Array.from(
      { length: NEURAL_MAX_GENERATIONS },
      () =>
        new RawShaderMaterial({
          uniforms: {
            ...createDefaultUniforms(),
            neuralW1: { value: new Float32Array(NEURAL_HIDDEN * NEURAL_INPUTS) },
            neuralB1: { value: new Float32Array(NEURAL_HIDDEN) },
            neuralW2: { value: new Float32Array(NEURAL_OUTPUTS * NEURAL_HIDDEN) },
            neuralRate: { value: { ...defaultUniformValue, value: 30 } },
            neuralChaos: { value: { ...defaultUniformValue, value: 50 } },
            neuralTwist: { value: { ...defaultUniformValue } },
            neuralReachX: { value: { ...defaultUniformValue, value: 0.125 } },
            neuralReachY: { value: { ...defaultUniformValue, value: 1 } },
            neuralUvPerBeat: { value: 0 },
            neuralGeneration: { value: 0 },
            neuralEdgeMode: { value: 1 },
          },
          vertexShader: rangeQuadVert,
          fragmentShader: neuralEffectFrag,
          glslVersion: GLSL3,
        }),
    );
  }

  getActivePasses(state: State): number[] {
    return Array.from({ length: neuralGenerationCount(state) }, (_, index) => index);
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const material = this.materials[props.passIndex];
    if (!material) return;

    const updateParam = (uniformName: string, stateKey: keyof typeof state) => {
      material.uniforms[uniformName].value = parameterUniform(state, stateKey, props.modContext);
    };

    updateParam("neuralRate", "neuralRate");
    updateParam("neuralChaos", "neuralChaos");
    updateParam("neuralTwist", "neuralTwist");
    updateParam("neuralReachX", "neuralReachX");
    updateParam("neuralReachY", "neuralReachY");
    material.uniforms.neuralEdgeMode.value = state.neuralEdgeMode;

    const weights = neuralWeights(state.neuralSeed);
    material.uniforms.neuralW1.value = weights.w1;
    material.uniforms.neuralB1.value = weights.b1;
    material.uniforms.neuralW2.value = weights.w2;

    const generations = neuralGenerationCount(state);
    material.uniforms.neuralGeneration.value = generations > 1 ? props.passIndex / (generations - 1) : 0;

    const dest = destinationLayout(props.commonUniforms);
    if (dest.totalDuration > 0 && dest.numBands > 0) {
      material.uniforms.neuralUvPerBeat.value = unitsToUv(
        1,
        0,
        dest.bpm,
        dest.totalDuration,
        dest.bandsPerOctave,
        dest.numBands,
      ).x;
    }
  }
}

export const neuralEffect = new NeuralEffect();
