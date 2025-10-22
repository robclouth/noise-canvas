import { BrushPresetType } from "./preset-schema";

export const defaultPresets: BrushPresetType[] = [
  {
    id: "default",
    name: "Default",
    isDefault: true,
    version: 1,

    // Brush parameters
    brushIntensity: 100,
    brushIterations: 1,
    brushPan: 0,
    brushFeatherTime: 0,
    brushFeatherPitch: 0,
    brushFeatherSlopeTime: 0,
    brushFeatherSlopePitch: 0,
    algorithm: 2,

    // Brush size
    brushWidthBeats: 1,
    brushHeightSemis: 12,
    brushSizeLockedToGrid: false,
    brushWrapMode: 0,

    // Blend mode
    blendMode: 0,

    // Dynamics parameters
    dynamicsThresholdDb: -20.0,
    dynamicsUpperRatio: 1.0,
    dynamicsLowerRatio: 1.0,
    dynamicsKnee: 6.0,
    dynamicsGainDb: 0.0,

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
    effectOrder: ["synthesize", "dynamics", "transform", "harmonics", "blur"],
    effectsEnabled: {
      dynamics: true,
      synthesize: false,
      transform: false,
      harmonics: false,
      blur: false,
    },

    // Modulator parameters
    modulator1Mode: 0,
    modulator1PatternShape: 0,
    modulator1PhaseMode: 0,
    modulator1PatternRateBeats: 1,
    modulator1PatternRateSemis: 12,
    modulator1Strength: 100,
    modulator1Rotation: 0,
    modulator1EnvelopeMinDb: -60,
    modulator1EnvelopeMaxDb: 0,

    modulator2Mode: 0,
    modulator2PatternShape: 0,
    modulator2PhaseMode: 0,
    modulator2PatternRateBeats: 1,
    modulator2PatternRateSemis: 12,
    modulator2Strength: 100,
    modulator2Rotation: 0,
    modulator2EnvelopeMinDb: -60,
    modulator2EnvelopeMaxDb: 0,

    modulator3Mode: 0,
    modulator3PatternShape: 0,
    modulator3PhaseMode: 0,
    modulator3PatternRateBeats: 1,
    modulator3PatternRateSemis: 12,
    modulator3Strength: 100,
    modulator3Rotation: 0,
    modulator3EnvelopeMinDb: -60,
    modulator3EnvelopeMaxDb: 0,

    // All modulator amounts default to 0
    brushIntensityMod1Amount: 0,
    brushIntensityMod2Amount: 0,
    brushIntensityMod3Amount: 0,
    brushPanMod1Amount: 0,
    brushPanMod2Amount: 0,
    brushPanMod3Amount: 0,
    dynamicsGainDbMod1Amount: 0,
    dynamicsGainDbMod2Amount: 0,
    dynamicsGainDbMod3Amount: 0,
    dynamicsThresholdDbMod1Amount: 0,
    dynamicsThresholdDbMod2Amount: 0,
    dynamicsThresholdDbMod3Amount: 0,
    dynamicsUpperRatioMod1Amount: 0,
    dynamicsUpperRatioMod2Amount: 0,
    dynamicsUpperRatioMod3Amount: 0,
    dynamicsLowerRatioMod1Amount: 0,
    dynamicsLowerRatioMod2Amount: 0,
    dynamicsLowerRatioMod3Amount: 0,
    dynamicsKneeMod1Amount: 0,
    dynamicsKneeMod2Amount: 0,
    dynamicsKneeMod3Amount: 0,
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
