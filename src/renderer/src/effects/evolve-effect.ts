import { GLSL3, RawShaderMaterial } from "three";
import evolveEffectFrag from "../glsl/evolve-effect.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { useStore } from "../store";
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { EVOLVE_SCALE_FULL_BEATS, EVOLVE_SCALE_FULL_SEMIS } from "@renderer/lib/constants";
import { unitsToUv } from "@renderer/lib/utils";
import { BaseEffect, createDefaultUniforms, sourceLayout, UpdateEffectUniformsProps } from "./base-effect";

const defaultUniformValue = defaultParameterUniform(0, -100, 100);

class EvolveEffect extends BaseEffect {
  readsNearInParts = true;

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          evolveFlow: { value: { ...defaultUniformValue } },
          evolveSpread: { value: { ...defaultUniformValue } },
          evolveGrow: { value: { ...defaultUniformValue } },
          evolveSwirl: { value: { ...defaultUniformValue } },
          evolveDriftX: { value: { ...defaultUniformValue } },
          evolveDriftY: { value: { ...defaultUniformValue } },
          evolveDecay: { value: { ...defaultUniformValue } },
          evolveScaleX: { value: { ...defaultUniformValue, value: 50 } },
          evolveScaleY: { value: { ...defaultUniformValue, value: 50 } },
          evolveEdgeMode: { value: 1 },
        },
        vertexShader: rangeQuadVert,
        fragmentShader: evolveEffectFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const material = this.materials[props.passIndex];

    // Helper to update a parameter uniform
    const updateParam = (uniformName: string, stateKey: keyof typeof state) => {
      material.uniforms[uniformName].value = parameterUniform(state, stateKey, props.modContext);
    };

    updateParam("evolveFlow", "evolveFlow");
    updateParam("evolveSpread", "evolveSpread");
    updateParam("evolveGrow", "evolveGrow");
    updateParam("evolveSwirl", "evolveSwirl");
    updateParam("evolveDriftX", "evolveDriftX");
    updateParam("evolveDriftY", "evolveDriftY");
    updateParam("evolveDecay", "evolveDecay");

    // The neighbourhood is an offset added to a source UV, so its beats and
    // semitones convert against the span the source textures hold.
    const source = sourceLayout(props.commonUniforms);
    const bpm = state.filepathsBpm[props.file.filePath] || 120;
    const toUv = (beats: number, semis: number): { x: number; y: number } =>
      unitsToUv(beats, semis, bpm, source.totalDuration, source.bandsPerOctave, source.numBands);
    const full = toUv(EVOLVE_SCALE_FULL_BEATS, EVOLVE_SCALE_FULL_SEMIS);
    const scale = toUv(
      (state.evolveScaleX / 100) * EVOLVE_SCALE_FULL_BEATS,
      (state.evolveScaleY / 100) * EVOLVE_SCALE_FULL_SEMIS,
    );
    material.uniforms.evolveScaleX.value = parameterUniform(state, "evolveScaleX", props.modContext, {
      value: scale.x,
      min: -full.x,
      max: full.x,
    });
    material.uniforms.evolveScaleY.value = parameterUniform(state, "evolveScaleY", props.modContext, {
      value: scale.y,
      min: -full.y,
      max: full.y,
    });
    material.uniforms.evolveEdgeMode.value = state.evolveEdgeMode;
  }
}

export const evolveEffect = new EvolveEffect();
