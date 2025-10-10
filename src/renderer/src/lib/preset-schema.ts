// Zod schema for validating brush presets
import { z } from "zod";

// Define the effect types enum
const EffectTypeSchema = z.enum(["synthesize", "dynamics", "transform", "harmonics", "blur"]);

// Schema for effect order array
const EffectOrderSchema = z.array(EffectTypeSchema);

// Schema for effects enabled object
const EffectsEnabledSchema = z.record(EffectTypeSchema, z.boolean());

// Main preset schema
export const BrushPresetSchema = z.object({
  // Metadata
  id: z.string().min(1, "ID is required"),
  name: z.string().min(1, "Name is required"),
  isDefault: z.boolean(),

  // Brush parameters
  brushIntensity: z.number().min(0).max(100),
  brushIterations: z.number().int().min(1).max(20),
  brushPan: z.number().min(-100).max(100),
  brushFeatherTime: z.number().min(0).max(100),
  brushFeatherPitch: z.number().min(0).max(100),
  brushFeatherSlopeTime: z.number().min(-100).max(100),
  brushFeatherSlopePitch: z.number().min(-100).max(100),

  // Brush size
  brushWidthBeats: z.number().int().min(0),
  brushHeightSemis: z.number().int().min(0),
  brushSizeLockedToGrid: z.boolean(),
  brushWrapMode: z.number().int().min(0),

  // Blend mode
  blendMode: z.number().int().min(0),

  // Dynamics parameters
  dynamicsThresholdDb: z.number().min(-60).max(0),
  dynamicsUpperRatio: z.number().min(-8).max(8),
  dynamicsLowerRatio: z.number().min(-8).max(8),
  dynamicsKnee: z.number().min(0).max(48),
  dynamicsGainDb: z.number().min(-80).max(24),

  // Blur parameters
  blurAmountTime: z.number().min(0).max(100),
  blurAmountPitch: z.number().min(0).max(100),
  blurNoiseTime: z.number().min(0).max(100),
  blurNoisePitch: z.number().min(0).max(100),
  blurBleed: z.boolean(),
  blurOrigin: z.number().int().min(0).max(2),

  // Sharpen parameters
  sharpenAmountTime: z.number().min(0).max(100),
  sharpenAmountPitch: z.number().min(0).max(100),

  // Harmonics parameters
  harmonicsPower: z.number().min(0.1).max(4),
  harmonicsFalloff: z.number().min(0).max(100),

  // Transform parameters
  transformShiftBeats: z.number().int(),
  transformShiftSemis: z.number(),
  transformScaleTime: z.number(),
  transformScalePitch: z.number(),
  transformRotation: z.number().min(-180).max(180),
  transformEdgeMode: z.number().int().min(0),

  // Synthesize parameters
  synthesizeBrushType: z.number().int().min(0),

  // Effect order and enabled states
  effectOrder: EffectOrderSchema,
  effectsEnabled: EffectsEnabledSchema,

  // Modulator parameters (1-3)
  modulator1Mode: z.number().int().min(0),
  modulator1PatternShape: z.number().int().min(0),
  modulator1PhaseMode: z.number().int().min(0).max(1),
  modulator1PatternRateBeats: z.number().int().min(0),
  modulator1PatternRateSemis: z.number().int().min(0),
  modulator1Strength: z.number().min(-100).max(100),
  modulator1Rotation: z.number().min(0).max(360),
  modulator1EnvelopeMinDb: z.number().min(-120).max(0),
  modulator1EnvelopeMaxDb: z.number().min(-120).max(0),

  modulator2Mode: z.number().int().min(0),
  modulator2PatternShape: z.number().int().min(0),
  modulator2PhaseMode: z.number().int().min(0).max(1),
  modulator2PatternRateBeats: z.number().int().min(0),
  modulator2PatternRateSemis: z.number().int().min(0),
  modulator2Strength: z.number().min(-100).max(100),
  modulator2Rotation: z.number().min(0).max(360),
  modulator2EnvelopeMinDb: z.number().min(-120).max(0),
  modulator2EnvelopeMaxDb: z.number().min(-120).max(0),

  modulator3Mode: z.number().int().min(0),
  modulator3PatternShape: z.number().int().min(0),
  modulator3PhaseMode: z.number().int().min(0).max(1),
  modulator3PatternRateBeats: z.number().int().min(0),
  modulator3PatternRateSemis: z.number().int().min(0),
  modulator3Strength: z.number().min(-100).max(100),
  modulator3Rotation: z.number().min(0).max(360),
  modulator3EnvelopeMinDb: z.number().min(-120).max(0),
  modulator3EnvelopeMaxDb: z.number().min(-120).max(0),

  // Modulator amounts
  brushIntensityMod1Amount: z.number().min(-100).max(100),
  brushIntensityMod2Amount: z.number().min(-100).max(100),
  brushIntensityMod3Amount: z.number().min(-100).max(100),
  brushPanMod1Amount: z.number().min(-100).max(100),
  brushPanMod2Amount: z.number().min(-100).max(100),
  brushPanMod3Amount: z.number().min(-100).max(100),
  dynamicsGainDbMod1Amount: z.number().min(-100).max(100),
  dynamicsGainDbMod2Amount: z.number().min(-100).max(100),
  dynamicsGainDbMod3Amount: z.number().min(-100).max(100),
  dynamicsThresholdDbMod1Amount: z.number().min(-100).max(100),
  dynamicsThresholdDbMod2Amount: z.number().min(-100).max(100),
  dynamicsThresholdDbMod3Amount: z.number().min(-100).max(100),
  dynamicsUpperRatioMod1Amount: z.number().min(-100).max(100),
  dynamicsUpperRatioMod2Amount: z.number().min(-100).max(100),
  dynamicsUpperRatioMod3Amount: z.number().min(-100).max(100),
  dynamicsLowerRatioMod1Amount: z.number().min(-100).max(100),
  dynamicsLowerRatioMod2Amount: z.number().min(-100).max(100),
  dynamicsLowerRatioMod3Amount: z.number().min(-100).max(100),
  dynamicsKneeMod1Amount: z.number().min(-100).max(100),
  dynamicsKneeMod2Amount: z.number().min(-100).max(100),
  dynamicsKneeMod3Amount: z.number().min(-100).max(100),
  blurAmountTimeMod1Amount: z.number().min(-100).max(100),
  blurAmountTimeMod2Amount: z.number().min(-100).max(100),
  blurAmountTimeMod3Amount: z.number().min(-100).max(100),
  blurAmountPitchMod1Amount: z.number().min(-100).max(100),
  blurAmountPitchMod2Amount: z.number().min(-100).max(100),
  blurAmountPitchMod3Amount: z.number().min(-100).max(100),
  blurNoiseTimeMod1Amount: z.number().min(-100).max(100),
  blurNoiseTimeMod2Amount: z.number().min(-100).max(100),
  blurNoiseTimeMod3Amount: z.number().min(-100).max(100),
  blurNoisePitchMod1Amount: z.number().min(-100).max(100),
  blurNoisePitchMod2Amount: z.number().min(-100).max(100),
  blurNoisePitchMod3Amount: z.number().min(-100).max(100),
  harmonicsPowerMod1Amount: z.number().min(-100).max(100),
  harmonicsPowerMod2Amount: z.number().min(-100).max(100),
  harmonicsPowerMod3Amount: z.number().min(-100).max(100),
  harmonicsFalloffMod1Amount: z.number().min(-100).max(100),
  harmonicsFalloffMod2Amount: z.number().min(-100).max(100),
  harmonicsFalloffMod3Amount: z.number().min(-100).max(100),
  transformShiftBeatsMod1Amount: z.number().min(-100).max(100),
  transformShiftBeatsMod2Amount: z.number().min(-100).max(100),
  transformShiftBeatsMod3Amount: z.number().min(-100).max(100),
  transformShiftSemisMod1Amount: z.number().min(-100).max(100),
  transformShiftSemisMod2Amount: z.number().min(-100).max(100),
  transformShiftSemisMod3Amount: z.number().min(-100).max(100),
  transformScaleTimeMod1Amount: z.number().min(-100).max(100),
  transformScaleTimeMod2Amount: z.number().min(-100).max(100),
  transformScaleTimeMod3Amount: z.number().min(-100).max(100),
  transformScalePitchMod1Amount: z.number().min(-100).max(100),
  transformScalePitchMod2Amount: z.number().min(-100).max(100),
  transformScalePitchMod3Amount: z.number().min(-100).max(100),
  transformRotationMod1Amount: z.number().min(-100).max(100),
  transformRotationMod2Amount: z.number().min(-100).max(100),
  transformRotationMod3Amount: z.number().min(-100).max(100),
});

// Type inference from schema
export type BrushPresetType = z.infer<typeof BrushPresetSchema>;

// Validation function with detailed error reporting
export function validatePreset(
  data: unknown,
): { success: true; data: BrushPresetType } | { success: false; errors: string[] } {
  try {
    const validatedData = BrushPresetSchema.parse(data);
    return { success: true, data: validatedData };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.issues.map((err) => {
        const path = err.path.length > 0 ? `${err.path.join(".")}: ` : "";
        return `${path}${err.message}`;
      });
      return { success: false, errors };
    }
    return { success: false, errors: ["Unknown validation error"] };
  }
}

// Safe validation that returns undefined for invalid presets
export function safeValidatePreset(data: unknown): BrushPresetType | undefined {
  const result = validatePreset(data);
  return result.success ? result.data : undefined;
}
