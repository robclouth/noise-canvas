import { NUM_MACROS, NUM_MODULATORS } from "@renderer/lib/constants";
import { getAllEffectParameterKeys } from "@renderer/parameters";
import type { ParameterKey } from "@renderer/store/types";

/** Envelope parameters: size, curve and skew per axis, plus intensity. */
export const ENVELOPE_PARAMS: ParameterKey[] = [
  "brushIntensity",
  "brushAnchorMode",
  "brushSizeTime",
  "brushCurveTime",
  "brushSkewTime",
  "brushSizePitch",
  "brushCurvePitch",
  "brushSkewPitch",
];

/** Options parameters, split from the envelope. */
export const OPTIONS_PARAMS: ParameterKey[] = [
  "blendMode",
  "brushPan",
  "brushIterations",
  "brushWrapMode",
  "algorithm",
  "sourceDataMode",
  "accumulate",
];

export const MODULATOR_PARAMS = Array.from({ length: NUM_MODULATORS }).flatMap((_, i) => {
  const idx = i + 1;
  return [
    `modulator${idx}Mode`,
    `modulator${idx}PatternShape`,
    `modulator${idx}PatternRateBeats`,
    `modulator${idx}PatternRateSemis`,
    `modulator${idx}Rotation`,
    `modulator${idx}PhaseMode`,
    `modulator${idx}Strength`,
    `modulator${idx}EnvelopeMinDb`,
    `modulator${idx}EnvelopeMaxDb`,
  ] as ParameterKey[];
});

export const MACRO_PARAMS = Array.from({ length: NUM_MACROS }, (_, i) => `macro${i + 1}Value` as ParameterKey);

/**
 * Every effect's parameters, for the Effects section header's reset, randomise
 * and preset actions. Derived rather than listed, so a new effect is covered
 * the moment its parameters declare an effectType.
 */
export const ALL_EFFECT_PARAMS: ParameterKey[] = getAllEffectParameterKeys();

/** The storage key a section's randomise amount and its presets are held under. */
export function sectionStorageKey(label: string): string {
  return `section-${label}`;
}

export interface BrushSection {
  label: string;
  parameterKeys: ParameterKey[];
  /** True where the section owns the effect chain's order and enabled states. */
  includeEffectOrder?: boolean;
}

/** The sections one keystroke re-rolls, each at the amount its own menu holds. */
export const RANDOMIZABLE_BRUSH_SECTIONS: BrushSection[] = [
  { label: "Envelope", parameterKeys: ENVELOPE_PARAMS },
  { label: "Options", parameterKeys: OPTIONS_PARAMS },
  { label: "Effects", parameterKeys: ALL_EFFECT_PARAMS, includeEffectOrder: true },
];
