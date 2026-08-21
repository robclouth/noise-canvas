import { useStore } from "@/store";
import { buildScaleOffsets, minFreqSemisAboveC0 } from "@renderer/lib/scale-snap";
import { unitsToUv } from "@renderer/lib/utils";
import type { EffectsState } from "@renderer/store/effects";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial, Vector2 } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import transformEffectFrag from "../glsl/transform-effect.frag";
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
          shiftX: {
            value: {
              value: 0.0,
              minValue: -1.0,
              maxValue: 1.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },

          shiftY: {
            value: {
              value: 0.0,
              minValue: -1.0,
              maxValue: 1.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },
          scaleX: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },
          scaleY: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },
          rotation: {
            value: {
              value: 0.0,
              minValue: -180.0,
              maxValue: 180.0,
              modulationAmounts: [],
              contextualModAmounts: [],
              macroAmounts: [],
            },
          },
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
    const {
      transformShiftBeats,
      transformShiftSemis,
      transformScaleTime,
      transformScalePitch,
      transformRotation,
      transformEdgeMode,
      transformOriginTime,
      transformOriginPitch,
    } = state;

    const { passIndex } = props;
    const dest = destinationLayout(props.commonUniforms);
    if (!(dest.totalDuration > 0) || !(dest.numBands > 0)) return;

    const shiftUv = unitsToUv(
      transformShiftBeats,
      transformShiftSemis,
      dest.bpm,
      dest.totalDuration,
      dest.bandsPerOctave,
      dest.numBands,
    );

    const material = this.materials[passIndex];
    if (!material) return;

    material.uniforms.shiftX.value = {
      value: shiftUv.x,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: getModAmountValuesNormalized(state, "transformShiftBeats"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transformShiftBeats"),
      macroAmounts: getMacroAmountValuesNormalized(state, "transformShiftBeats"),
    };
    material.uniforms.shiftY.value = {
      value: shiftUv.y,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: getModAmountValuesNormalized(state, "transformShiftSemis"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transformShiftSemis"),
      macroAmounts: getMacroAmountValuesNormalized(state, "transformShiftSemis"),
    };
    material.uniforms.scaleX.value = {
      value: transformScaleTime,
      minValue: -4,
      maxValue: 4,
      modulationAmounts: getModAmountValuesNormalized(state, "transformScaleTime"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transformScaleTime"),
      macroAmounts: getMacroAmountValuesNormalized(state, "transformScaleTime"),
    };
    material.uniforms.scaleY.value = {
      value: transformScalePitch,
      minValue: -4,
      maxValue: 4,
      modulationAmounts: getModAmountValuesNormalized(state, "transformScalePitch"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transformScalePitch"),
      macroAmounts: getMacroAmountValuesNormalized(state, "transformScalePitch"),
    };
    material.uniforms.rotation.value = {
      value: transformRotation,
      minValue: -180,
      maxValue: 180,
      modulationAmounts: getModAmountValuesNormalized(state, "transformRotation"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "transformRotation"),
      macroAmounts: getMacroAmountValuesNormalized(state, "transformRotation"),
    };
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
