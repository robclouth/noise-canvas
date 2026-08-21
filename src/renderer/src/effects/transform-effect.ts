import { useStore } from "@/store";
import { buildScaleOffsets, minFreqSemisAboveC0 } from "@renderer/lib/scale-snap";
import type { EffectsState } from "@renderer/store/effects";
import { GLSL3, RawShaderMaterial, Vector2 } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import transformEffectFrag from "../glsl/transform-effect.frag";
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { BaseEffect, createDefaultUniforms, destinationLayout, UpdateEffectUniformsProps } from "./base-effect";

export const boundaryModes = ["smear", "cut", "wrap"] as const;
export type BoundaryMode = (typeof boundaryModes)[number];

/** Turns an origin option (0 low, 1 middle, 2 high) into its fraction of the brush. */
function originFraction(option: number): number {
  return Math.min(2, Math.max(0, option)) * 0.5;
}

class TransformEffect extends BaseEffect {
  materials: RawShaderMaterial[];
  parameters: (keyof EffectsState)[];

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          shiftX: { value: defaultParameterUniform(0.0, -32, 32) },
          shiftY: { value: defaultParameterUniform(0.0, -96.0, 96.0) },
          scaleX: { value: defaultParameterUniform(1.0, -256, 256) },
          scaleY: { value: defaultParameterUniform(1.0, -256, 256) },
          transformBeatsToUv: { value: 0.0 },
          rotation: { value: defaultParameterUniform(0.0, -180.0, 180.0) },
          boundaryMode: {
            value: 0,
          },
          transformOrigin: { value: new Vector2(0, 0) },
          scaleSnapEnabled: { value: false },
          scaleOffsets: { value: new Float32Array(12) },
          brushBasePitchAbsSemis: { value: 0.0 },
        },
        vertexShader: passThroughVert,
        fragmentShader: transformEffectFrag,
        glslVersion: GLSL3,
      }),
    ];
    this.parameters = [
      "transformShiftBeats",
      "transformShiftSemis",
      "transformScaleTime",
      "transformScalePitch",
      "transformRotation",
      "transformEdgeMode",
      "transformOriginTime",
      "transformOriginPitch",
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const { transformRotation, transformEdgeMode, transformOriginTime, transformOriginPitch } = state;

    const { passIndex } = props;
    const dest = destinationLayout(props.commonUniforms);
    if (!(dest.totalDuration > 0) || !(dest.numBands > 0)) return;

    const material = this.materials[passIndex];
    if (!material) return;

    // Shift ↔ reaches the shader in beats, and the beat-to-UV factor carries the destination's tempo.
    material.uniforms.shiftX.value = parameterUniform(state, "transformShiftBeats", props.modContext);
    material.uniforms.transformBeatsToUv.value = 60 / dest.bpm / dest.totalDuration;
    material.uniforms.shiftY.value = parameterUniform(state, "transformShiftSemis", props.modContext);
    material.uniforms.scaleX.value = parameterUniform(state, "transformScaleTime", props.modContext);
    material.uniforms.scaleY.value = parameterUniform(state, "transformScalePitch", props.modContext);
    material.uniforms.rotation.value = parameterUniform(state, "transformRotation", props.modContext, {
      value: transformRotation,
      min: -180,
      max: 180,
    });
    material.uniforms.boundaryMode.value = transformEdgeMode;
    material.uniforms.transformOrigin.value.set(
      originFraction(transformOriginTime),
      originFraction(transformOriginPitch),
    );

    // Scale snapping: anchor the snap to the brush's pitch-low edge (= the UV position the
    // pointer snap places on a scale note). brushBottomLeftUv is in pitch-UV convention
    // (y=0 at band 0 / low pitch, y=1 at the top band), built via unitsToUv(pitch, ...).
    // Active when the pitch grid is in "Scale" mode (gridSizeSemis === 0) and pitch snap is on.
    const { scaleTonic, scaleType, gridSizeSemis, snapPitch } = state;
    const scaleSnapActive = gridSizeSemis <= 0 && snapPitch;
    material.uniforms.scaleSnapEnabled.value = scaleSnapActive;
    material.uniforms.scaleOffsets.value = buildScaleOffsets(scaleTonic, scaleType);
    if (scaleSnapActive) {
      const bandsPerSemitone = dest.bandsPerOctave / 12;
      const bandIndex = props.commonUniforms.brushBottomLeftUv.value.y * dest.numBands;
      const semisAboveMinFreq = bandIndex / bandsPerSemitone;
      material.uniforms.brushBasePitchAbsSemis.value = minFreqSemisAboveC0(dest.minFreq) + semisAboveMinFreq;
    }
  }
}

export const transformEffect = new TransformEffect();
