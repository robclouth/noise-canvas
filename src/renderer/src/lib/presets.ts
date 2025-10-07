// Preset types and default presets for Noise Canvas

import { State } from "@renderer/store";

// List of all state keys that are included in presets
// Note: This is a const array - TypeScript will infer the exact keys from the values
export const PRESET_KEYS = [
  // Brush parameters
  "brushIntensity",
  "brushIterations",
  "brushPan",
  "brushFeatherTime",
  "brushFeatherPitch",
  "brushFeatherSlopeTime",
  "brushFeatherSlopePitch",
  // Brush size
  "brushWidthBeats",
  "brushHeightSemis",
  "brushSizeLockedToGrid",
  "brushWrapMode",
  // Blend mode
  "blendMode",
  // Effect parameters
  "gainDb",
  "dynamicsThresholdDb",
  "dynamicsUpperRatio",
  "dynamicsLowerRatio",
  "dynamicsKnee",
  "blurAmountTime",
  "blurAmountPitch",
  "blurNoiseTime",
  "blurNoisePitch",
  "blurBleed",
  "blurOrigin",
  "sharpenAmountTime",
  "sharpenAmountPitch",
  "harmonicsPower",
  "harmonicsFalloff",
  "transformShiftBeats",
  "transformShiftSemis",
  "transformScaleTime",
  "transformScalePitch",
  "transformRotation",
  "transformEdgeMode",
  "synthesizeBrushType",
  // Effect order and enabled states
  "effectOrder",
  "effectsEnabled",
  // Modulator parameters
  "modulator1Mode",
  "modulator1PatternShape",
  "modulator1PhaseMode",
  "modulator1PatternRateBeats",
  "modulator1PatternRateSemis",
  "modulator1Strength",
  "modulator1Rotation",
  "modulator2Mode",
  "modulator2PatternShape",
  "modulator2PhaseMode",
  "modulator2PatternRateBeats",
  "modulator2PatternRateSemis",
  "modulator2Strength",
  "modulator2Rotation",
  "modulator3Mode",
  "modulator3PatternShape",
  "modulator3PhaseMode",
  "modulator3PatternRateBeats",
  "modulator3PatternRateSemis",
  "modulator3Strength",
  "modulator3Rotation",
  // Modulator amounts
  "brushIntensityMod1Amount",
  "brushIntensityMod2Amount",
  "brushIntensityMod3Amount",
  "brushPanMod1Amount",
  "brushPanMod2Amount",
  "brushPanMod3Amount",
  "gainDbMod1Amount",
  "gainDbMod2Amount",
  "gainDbMod3Amount",
  "blurAmountTimeMod1Amount",
  "blurAmountTimeMod2Amount",
  "blurAmountTimeMod3Amount",
  "blurAmountPitchMod1Amount",
  "blurAmountPitchMod2Amount",
  "blurAmountPitchMod3Amount",
  "blurNoiseTimeMod1Amount",
  "blurNoiseTimeMod2Amount",
  "blurNoiseTimeMod3Amount",
  "blurNoisePitchMod1Amount",
  "blurNoisePitchMod2Amount",
  "blurNoisePitchMod3Amount",
  "sharpenAmountTimeMod1Amount",
  "sharpenAmountTimeMod2Amount",
  "sharpenAmountTimeMod3Amount",
  "sharpenAmountPitchMod1Amount",
  "sharpenAmountPitchMod2Amount",
  "sharpenAmountPitchMod3Amount",
  "harmonicsPowerMod1Amount",
  "harmonicsPowerMod2Amount",
  "harmonicsPowerMod3Amount",
  "harmonicsFalloffMod1Amount",
  "harmonicsFalloffMod2Amount",
  "harmonicsFalloffMod3Amount",
  "transformShiftBeatsMod1Amount",
  "transformShiftBeatsMod2Amount",
  "transformShiftBeatsMod3Amount",
  "transformShiftSemisMod1Amount",
  "transformShiftSemisMod2Amount",
  "transformShiftSemisMod3Amount",
  "transformScaleTimeMod1Amount",
  "transformScaleTimeMod2Amount",
  "transformScaleTimeMod3Amount",
  "transformScalePitchMod1Amount",
  "transformScalePitchMod2Amount",
  "transformScalePitchMod3Amount",
  "transformRotationMod1Amount",
  "transformRotationMod2Amount",
  "transformRotationMod3Amount",
] as const;

// Extract the specific keys from PRESET_KEYS
export type PresetKey = (typeof PRESET_KEYS)[number];

// Helper type to extract the value from a parameter or return the type directly
type ExtractValue<T> = T extends { value: infer V } ? V : T;

// Automatically generate the preset data type from State based on the exact PRESET_KEYS
type PresetData = {
  [K in PresetKey]: K extends keyof State ? ExtractValue<State[K]> : never;
};

// BrushPreset combines metadata with the extracted preset values
export interface BrushPreset extends PresetData {
  id: string;
  name: string;
  isDefault: boolean;
}

// Default presets
export const defaultPresets: BrushPreset[] = [
  {
    id: "default",
    name: "Default",
    isDefault: true,

    // Brush parameters
    brushIntensity: 100,
    brushIterations: 1,
    brushPan: 0,
    brushFeatherTime: 0,
    brushFeatherPitch: 0,
    brushFeatherSlopeTime: 0,
    brushFeatherSlopePitch: 0,

    // Brush size
    brushWidthBeats: 1,
    brushHeightSemis: 12,
    brushSizeLockedToGrid: false,
    brushWrapMode: 0,

    // Blend mode
    blendMode: 0,

    // Effect parameters
    gainDb: 0.0,

    // Dynamics parameters
    dynamicsThresholdDb: -20.0,
    dynamicsUpperRatio: 1.0,
    dynamicsLowerRatio: 1.0,
    dynamicsKnee: 6.0,

    // Blur parameters
    blurAmountTime: 0,
    blurAmountPitch: 0,
    blurNoiseTime: 0,
    blurNoisePitch: 0,
    blurBleed: true,
    blurOrigin: 0,

    // Sharpen parameters
    sharpenAmountTime: 0,
    sharpenAmountPitch: 0,

    // Harmonics parameters
    harmonicsPower: 1.0,
    harmonicsFalloff: 10.0,

    // Transform parameters
    transformShiftBeats: 0,
    transformShiftSemis: 0.0,
    transformScaleTime: 1.0,
    transformScalePitch: 1.0,
    transformRotation: 0.0,
    transformEdgeMode: 1,

    // Synthesize parameters
    synthesizeBrushType: 0,

    // Effect order and enabled states
    effectOrder: ["gain", "dynamics", "transform", "harmonics", "blur", "synthesize", "sharpen"],
    effectsEnabled: {
      gain: true,
      dynamics: false,
      transform: false,
      harmonics: false,
      blur: false,
      synthesize: false,
      sharpen: false,
    },

    // Modulator parameters
    modulator1Mode: 0,
    modulator1PatternShape: 0,
    modulator1PhaseMode: 0,
    modulator1PatternRateBeats: 1,
    modulator1PatternRateSemis: 12,
    modulator1Strength: 100,
    modulator1Rotation: 0,

    modulator2Mode: 0,
    modulator2PatternShape: 0,
    modulator2PhaseMode: 0,
    modulator2PatternRateBeats: 1,
    modulator2PatternRateSemis: 12,
    modulator2Strength: 100,
    modulator2Rotation: 0,

    modulator3Mode: 0,
    modulator3PatternShape: 0,
    modulator3PhaseMode: 0,
    modulator3PatternRateBeats: 1,
    modulator3PatternRateSemis: 12,
    modulator3Strength: 100,
    modulator3Rotation: 0,

    // All modulator amounts default to 0
    brushIntensityMod1Amount: 0,
    brushIntensityMod2Amount: 0,
    brushIntensityMod3Amount: 0,
    brushPanMod1Amount: 0,
    brushPanMod2Amount: 0,
    brushPanMod3Amount: 0,
    gainDbMod1Amount: 0,
    gainDbMod2Amount: 0,
    gainDbMod3Amount: 0,
    blurAmountTimeMod1Amount: 0,
    blurAmountTimeMod2Amount: 0,
    blurAmountTimeMod3Amount: 0,
    blurAmountPitchMod1Amount: 0,
    blurAmountPitchMod2Amount: 0,
    blurAmountPitchMod3Amount: 0,
    blurNoiseTimeMod1Amount: 0,
    blurNoiseTimeMod2Amount: 0,
    blurNoiseTimeMod3Amount: 0,
    blurNoisePitchMod1Amount: 0,
    blurNoisePitchMod2Amount: 0,
    blurNoisePitchMod3Amount: 0,
    sharpenAmountTimeMod1Amount: 0,
    sharpenAmountTimeMod2Amount: 0,
    sharpenAmountTimeMod3Amount: 0,
    sharpenAmountPitchMod1Amount: 0,
    sharpenAmountPitchMod2Amount: 0,
    sharpenAmountPitchMod3Amount: 0,
    harmonicsPowerMod1Amount: 0,
    harmonicsPowerMod2Amount: 0,
    harmonicsPowerMod3Amount: 0,
    harmonicsFalloffMod1Amount: 0,
    harmonicsFalloffMod2Amount: 0,
    harmonicsFalloffMod3Amount: 0,
    transformShiftBeatsMod1Amount: 0,
    transformShiftBeatsMod2Amount: 0,
    transformShiftBeatsMod3Amount: 0,
    transformShiftSemisMod1Amount: 0,
    transformShiftSemisMod2Amount: 0,
    transformShiftSemisMod3Amount: 0,
    transformScaleTimeMod1Amount: 0,
    transformScaleTimeMod2Amount: 0,
    transformScaleTimeMod3Amount: 0,
    transformScalePitchMod1Amount: 0,
    transformScalePitchMod2Amount: 0,
    transformScalePitchMod3Amount: 0,
    transformRotationMod1Amount: 0,
    transformRotationMod2Amount: 0,
    transformRotationMod3Amount: 0,
  },
];
