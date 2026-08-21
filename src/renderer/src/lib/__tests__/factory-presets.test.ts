import { describe, expect, it, vi } from "vitest";

// parameters.ts sits in a cycle with the store; nothing here needs the store.
vi.mock("@renderer/store", () => ({ useStore: { getState: vi.fn() } }));

// Matches presets.test.ts: the registry is built from the real key list, so a
// new effect cannot fail validation here.
vi.mock("@renderer/effects", async () => {
  const { EFFECT_KEYS } = await import("@renderer/effects/types");
  return { effects: Object.fromEntries(EFFECT_KEYS.map((key: string) => [key, {}])) };
});

import type { EffectItem, EffectType } from "../../effects/types";
import { getEffectParameterKeys, getNumberParameterDef, parameterDefs } from "../../parameters";
import type { ParameterKey } from "../../store/types";
import { factoryPalettes } from "../factory-palettes";
import { factoryPresets } from "../factory-presets";
import { validatePreset } from "../preset-schema";

/** Vite resolves this at build time, so it is a real listing of what ships. */
const samples = import.meta.glob("../../../../../resources/samples/*");
const sampleNames = new Set(Object.keys(samples).map((path) => path.split("/").pop()!));

const MACRO_AMOUNT = /^(.*)ModMacro(\d)Amount$/;
const PLACEHOLDER_NAME = /^Macro [1-4]$/;

type Step = (typeof factoryPresets)[number]["steps"][number];

const stepEffects = (step: Step): EffectItem[] => (step.effects ?? []) as EffectItem[];

/** Every key a step carries, its own and its effect items', with the item's effect type. */
function stepEntries(step: Step): Array<{ key: string; value: unknown; effect?: EffectType }> {
  const own = Object.entries(step)
    .filter(([key]) => key !== "effects")
    .map(([key, value]) => ({ key, value }));
  const inEffects = stepEffects(step).flatMap((item) =>
    Object.entries(item.params ?? {}).map(([key, value]) => ({ key, value, effect: item.effect })),
  );
  return [...own, ...inEffects];
}

/** The macro indices a preset drives, and the amount each target is driven at. */
function macroTargets(preset: (typeof factoryPresets)[number]): Array<{ index: number; key: string; amount: number }> {
  return preset.steps.flatMap((step) =>
    stepEntries(step).flatMap(({ key, value }) => {
      const match = MACRO_AMOUNT.exec(key);
      if (!match || typeof value !== "number" || value === 0) return [];
      return [{ index: Number(match[2]), key, amount: value }];
    }),
  );
}

describe("factory presets", () => {
  it.each(factoryPresets.map((preset) => [preset.name, preset] as const))("%s validates", (_name, preset) => {
    const result = validatePreset(preset);
    expect(result.success ? [] : result.errors).toEqual([]);
  });

  it("gives every preset, step and effect item its own id", () => {
    const ids = factoryPresets.map((preset) => preset.id);
    expect(ids).toEqual([...new Set(ids)]);
    const names = factoryPresets.map((preset) => preset.name);
    expect(names).toEqual([...new Set(names)]);
    const stepIds = factoryPresets.flatMap((preset) => preset.steps.map((step) => step.id));
    expect(stepIds).toEqual([...new Set(stepIds)]);
    const effectIds = factoryPresets.flatMap((preset) =>
      preset.steps.flatMap((step) => stepEffects(step).map((item) => item.id)),
    );
    expect(effectIds).toEqual([...new Set(effectIds)]);
  });

  // A step is validated key by key, but an effect item's params are a free
  // record, so a misspelled one there would silently do nothing.
  it("names only parameters the effect actually has", () => {
    const unknown: string[] = [];
    for (const preset of factoryPresets) {
      for (const step of preset.steps) {
        for (const item of stepEffects(step)) {
          const allowed = new Set<string>(getEffectParameterKeys(item.effect));
          for (const key of Object.keys(item.params ?? {})) {
            if (!allowed.has(key)) unknown.push(`${preset.name}: ${item.effect}.${key}`);
          }
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("drives only modulatable parameters from a macro", () => {
    const offenders: string[] = [];
    for (const preset of factoryPresets) {
      for (const { key } of macroTargets(preset)) {
        const base = MACRO_AMOUNT.exec(key)![1] as ParameterKey;
        const def = parameterDefs[base];
        if (!def || def.kind !== "number" || !def.modulatable) offenders.push(`${preset.name}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names every macro it drives, and drives every macro it names", () => {
    const offenders: string[] = [];
    for (const preset of factoryPresets) {
      const driven = new Set(macroTargets(preset).map((target) => target.index));
      preset.macroNames.forEach((name, i) => {
        const index = i + 1;
        if (driven.has(index) && PLACEHOLDER_NAME.test(name)) offenders.push(`${preset.name}: macro ${index} unnamed`);
        if (!driven.has(index) && !PLACEHOLDER_NAME.test(name))
          offenders.push(`${preset.name}: "${name}" drives nothing`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("parks every macro on its knob", () => {
    for (const preset of factoryPresets) {
      expect(preset.macroValues).toHaveLength(4);
      for (const value of preset.macroValues) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  // Past a total weight of 100% the sources average each other, so a macro
  // parked on a value no longer lands on it.
  it("keeps the sources on one parameter inside a single sweep", () => {
    const offenders: string[] = [];
    for (const preset of factoryPresets) {
      for (const step of preset.steps) {
        const weights = new Map<string, number>();
        for (const { key, value } of stepEntries(step)) {
          const match = /^(.*)Mod(?:\d+Amount|Macro\d+Amount|[A-Z][A-Za-z]*)$/.exec(key);
          if (!match || typeof value !== "number" || value === 0) continue;
          weights.set(match[1], (weights.get(match[1]) ?? 0) + Math.abs(value));
        }
        for (const [key, weight] of weights) {
          if (weight > 100) offenders.push(`${preset.name}: ${key} at ${weight}%`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sets every value inside the parameter's range", () => {
    const offenders: string[] = [];
    for (const preset of factoryPresets) {
      for (const step of preset.steps) {
        for (const { key, value } of stepEntries(step)) {
          const def = parameterDefs[key as ParameterKey];
          if (!def || def.kind !== "number" || typeof value !== "number") continue;
          const { min, max, leftValue, rightValue, marks } = getNumberParameterDef(key as ParameterKey);
          // The sentinel stops that mean Off, Grid or Brush sit outside the range.
          if (value === leftValue?.value || value === rightValue?.value) continue;
          if (marks?.some((mark) => mark.value === value)) continue;
          if (value < min || value > max) offenders.push(`${preset.name}: ${key} = ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("points every file parameter at a sample that ships", () => {
    const missing: string[] = [];
    for (const preset of factoryPresets) {
      for (const step of preset.steps) {
        for (const { key, value } of stepEntries(step)) {
          const def = parameterDefs[key as ParameterKey];
          if (def?.kind !== "file" || value === null || value === undefined) continue;
          const { path } = value as { path: string };
          const name = path.replace("bundled://", "");
          if (!sampleNames.has(name)) missing.push(`${preset.name}: ${path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("factory palettes", () => {
  it("fills every palette from presets that exist", () => {
    for (const palette of factoryPalettes) {
      expect(palette.brushes.length).toBeGreaterThan(0);
    }
    expect(factoryPalettes.map((palette) => palette.name)).toEqual([
      "Restoration",
      "Breaks",
      "Vocals",
      "From Scratch",
      "Mixing",
      "Space",
      "Mangle",
    ]);
  });
});
