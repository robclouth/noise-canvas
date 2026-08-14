import { pickNextBrushColor, pickNextStepColor } from "@renderer/lib/colors";
import { generateRandomBrushName } from "@renderer/lib/preset-names";
import { DEFAULT_MACRO_NAMES, DEFAULT_MACRO_VALUES, type PresetType } from "@renderer/lib/preset-schema";
import { BrushStep, createDefaultStep } from "@renderer/parameters";
import type { Brush } from "./types";

function cloneStepsFromPreset(preset: PresetType): BrushStep[] {
  const presetSteps = preset.steps ?? [];
  if (presetSteps.length === 0) {
    return [createDefaultStep("Step 1", pickNextStepColor([]))];
  }
  const assignedColors: (BrushStep["color"] | undefined)[] = [];
  return presetSteps.map((presetStep, index) => {
    const color = presetStep.color ?? pickNextStepColor(assignedColors);
    assignedColors.push(color);
    const defaultStep = createDefaultStep(presetStep.name || `Step ${index + 1}`, color);
    return {
      ...defaultStep,
      ...presetStep,
      id: presetStep.id || defaultStep.id,
      color,
    } as BrushStep;
  });
}

export function makeEmptyBrush(paletteId: string, existingColors: Brush["color"][] = [], name?: string): Brush {
  return {
    id: crypto.randomUUID(),
    name: name ?? generateRandomBrushName(),
    paletteId,
    color: pickNextBrushColor(existingColors),
    hotkey: null,
    steps: [createDefaultStep("Step 1", pickNextStepColor([]))],
    linkedParams: [],
    libraryId: null,
    macroNames: [...DEFAULT_MACRO_NAMES],
    macroValues: [...DEFAULT_MACRO_VALUES],
  };
}

/** A brush cloned from `preset`. `id` overrides the generated one for a fixed identity. */
export function makeBrushFromPreset(
  preset: PresetType,
  existingColors: Brush["color"][],
  id?: string,
  paletteId = "",
): Brush {
  return {
    id: id ?? crypto.randomUUID(),
    name: preset.name,
    paletteId,
    color: preset.color ?? pickNextBrushColor(existingColors),
    hotkey: null,
    steps: cloneStepsFromPreset(preset),
    linkedParams: preset.linkedParams ?? [],
    libraryId: preset.id,
    macroNames: preset.macroNames ? [...preset.macroNames] : [...DEFAULT_MACRO_NAMES],
    macroValues: preset.macroValues ? [...preset.macroValues] : [...DEFAULT_MACRO_VALUES],
  };
}
