import { DataTexture, FloatType, GLSL3, NearestFilter, RawShaderMaterial, RedFormat, WebGLRenderer } from "three";
import ncaInitFrag from "../glsl/nca-init.frag";
import neuralEffectFrag from "../glsl/neural-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import rangeQuadVert from "../glsl/range-quad.vert";
import { useStore } from "../store";
import { NcaGpu } from "@renderer/lib/nca/nca-gpu";
import { NCA_GRID, NcaModel, parseModel } from "@renderer/lib/nca/nca-model";
import type { State } from "@renderer/store/types";
import { BaseEffect, CommonUniforms, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

/** Upper bound on automaton steps per dab. */
export const NEURAL_MAX_STEPS = 64;

let lastModelText: unknown = null;
let lastModel: NcaModel | null = null;

/** The model an effect's parameter holds, parsed once per distinct string. */
export function neuralModelOf(state: Pick<State, "neuralModel">): NcaModel | null {
  if (state.neuralModel !== lastModelText) {
    lastModelText = state.neuralModel;
    lastModel = parseModel(state.neuralModel);
  }
  return lastModel;
}

export function neuralStepCount(state: Pick<State, "neuralSteps">): number {
  const requested = Math.round(state.neuralSteps);
  return Math.min(NEURAL_MAX_STEPS, Math.max(1, Number.isFinite(requested) ? requested : 1));
}

function copyUniforms(material: RawShaderMaterial, commonUniforms: CommonUniforms): void {
  for (const key in commonUniforms) {
    const value = (commonUniforms as Record<string, { value: unknown }>)[key].value;
    if (key in material.uniforms) material.uniforms[key].value = value;
    else material.uniforms[key] = { value };
  }
}

/**
 * Grows a trained sound under the brush. Each dab lays the automaton's grid
 * over the brush, fills it from the sound there with the seed planted in the
 * middle, runs the model, and writes the grid back as level and phase.
 */
class NeuralEffect extends BaseEffect {
  materials: RawShaderMaterial[];
  private initMaterial: RawShaderMaterial;
  // Render targets belong to one renderer, so each gets its own grid.
  private grids = new WeakMap<WebGLRenderer, NcaGpu>();
  private phaseTexture: DataTexture | null = null;
  private phaseModel: NcaModel | null = null;

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          ncaState0: { value: null },
          ncaGrid: { value: NCA_GRID },
          neuralPhaseMode: { value: 0 },
          ncaPhase: { value: null },
          ncaHasPhase: { value: false },
        },
        vertexShader: rangeQuadVert,
        fragmentShader: neuralEffectFrag,
        glslVersion: GLSL3,
      }),
    ];
    this.initMaterial = new RawShaderMaterial({
      uniforms: { ...createDefaultUniforms(), ncaGrid: { value: NCA_GRID } },
      vertexShader: passThroughVert,
      fragmentShader: ncaInitFrag,
      glslVersion: GLSL3,
    });
  }

  // Without a trained model there is nothing to grow.
  getActivePasses(state: State): number[] {
    return neuralModelOf(state) ? [0] : [];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    this.materials[props.passIndex].uniforms.neuralPhaseMode.value = state.neuralPhase;
  }

  prepare(gl: WebGLRenderer, props: UpdateEffectUniformsProps): void {
    const state = props.state ?? useStore.getState();
    const model = neuralModelOf(state);
    if (!model) return;
    let grid = this.grids.get(gl);
    if (!grid) {
      grid = new NcaGpu();
      this.grids.set(gl, grid);
    }
    grid.setWeights(model.weights);
    copyUniforms(this.initMaterial, props.commonUniforms);
    grid.render(gl, this.initMaterial);
    grid.step(gl, neuralStepCount(state));
    const uniforms = this.materials[props.passIndex].uniforms;
    uniforms.ncaState0.value = grid.current.textures[0];
    uniforms.ncaPhase.value = this.learntPhase(model);
    uniforms.ncaHasPhase.value = uniforms.ncaPhase.value !== null;
  }

  /** The model's learnt phase as a texture of turns, made once per model. */
  private learntPhase(model: NcaModel): DataTexture | null {
    if (model !== this.phaseModel) {
      this.phaseTexture?.dispose();
      this.phaseTexture = null;
      this.phaseModel = model;
      if (model.phase) {
        const turns = Float32Array.from(model.phase, (byte) => byte / 256);
        this.phaseTexture = new DataTexture(turns, NCA_GRID, NCA_GRID, RedFormat, FloatType);
        this.phaseTexture.minFilter = NearestFilter;
        this.phaseTexture.magFilter = NearestFilter;
        this.phaseTexture.needsUpdate = true;
      }
    }
    return this.phaseTexture;
  }
}

export const neuralEffect = new NeuralEffect();
