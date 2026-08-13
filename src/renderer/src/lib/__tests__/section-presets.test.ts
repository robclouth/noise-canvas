import { getEffectType, parameterDefs } from "@renderer/parameters";
import type { ParameterKey } from "@renderer/store/types";
import { describe, expect, it } from "vitest";

import { factorySectionPresets } from "../factory-section-presets";
import {
  captureSectionValues,
  folderFor,
  pickSectionPresetColor,
  referencedFilePaths,
  resolveSectionPreset,
  SectionPreset,
  serializeSectionPreset,
  toParameterKey,
  toStorageId,
  validateSectionPreset,
} from "../section-presets";

const BLUR_KEYS: ParameterKey[] = ["blurAmountTime", "blurAmountPitch", "blurNoiseTime"];

const blurPreset: SectionPreset = {
  id: "test-blur",
  scope: "effect:blur",
  name: "Test",
  description: "",
  isFactory: false,
  color: { hue: "grape", variation: 0 },
  values: { blurAmountTime: 70 },
};

const modulatorKeys = (index: number): ParameterKey[] =>
  [`modulator${index}Mode`, `modulator${index}PatternRateBeats`] as ParameterKey[];

const defaultOf = (key: ParameterKey): unknown => parameterDefs[key]?.default;

describe("section presets", () => {
  it("writes the values it names and defaults the rest", () => {
    const resolved = resolveSectionPreset(blurPreset, { scope: "effect:blur", effectId: "e1" }, BLUR_KEYS);

    expect(resolved).toEqual([
      { key: "blurAmountTime", value: 70 },
      { key: "blurAmountPitch", value: defaultOf("blurAmountPitch") },
      { key: "blurNoiseTime", value: defaultOf("blurNoiseTime") },
    ]);
  });

  it("leaves a file parameter alone unless the preset names one", () => {
    const keys: ParameterKey[] = ["convolveIrFile", "convolveIrSize"];
    const target = { scope: "effect:convolve", effectId: "e1" } as const;
    const preset: SectionPreset = { ...blurPreset, scope: "effect:convolve", values: { convolveIrSize: 128 } };

    expect(resolveSectionPreset(preset, target, keys)).toEqual([{ key: "convolveIrSize", value: 128 }]);

    const named = { ...preset, values: { ...preset.values, convolveIrFile: { path: "/ir/hall.wav" } } };
    const resolved = resolveSectionPreset(named, target, keys);

    expect(resolved).toContainEqual({ key: "convolveIrFile", value: { path: "/ir/hall.wav" } });
    expect(referencedFilePaths(resolved)).toEqual(["/ir/hall.wav"]);
  });

  it("loads a modulator preset onto a different modulator", () => {
    const captured = captureSectionValues("modulator", modulatorKeys(1), (key) => (key === "modulator1Mode" ? 2 : 8));

    expect(Object.keys(captured)).toEqual(["Mode", "PatternRateBeats"]);

    const preset: SectionPreset = { ...blurPreset, scope: "modulator", values: captured };
    const resolved = resolveSectionPreset(preset, { scope: "modulator", modulatorIndex: 3 }, modulatorKeys(3));

    expect(resolved).toEqual([
      { key: "modulator3Mode", value: 2 },
      { key: "modulator3PatternRateBeats", value: 8 },
    ]);
  });

  it("keeps effect keys as they are", () => {
    expect(toStorageId("effect:blur", "blurAmountTime")).toBe("blurAmountTime");
    expect(toParameterKey({ scope: "effect:blur", effectId: "e1" }, "blurAmountTime")).toBe("blurAmountTime");
  });

  it("files each scope under its own folder", () => {
    expect(folderFor("effect:blur")).toBe("effects");
    expect(folderFor("modulator")).toBe("modulators");
  });

  it("never trusts a file to declare itself factory", () => {
    const onDisk = JSON.parse(serializeSectionPreset({ ...blurPreset, isFactory: true }));
    expect(onDisk.isFactory).toBeUndefined();

    const result = validateSectionPreset({ ...onDisk, isFactory: true });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed preset", () => {
    expect(validateSectionPreset({ id: "x", scope: "effect:blur" }).success).toBe(false);
    expect(validateSectionPreset(null).success).toBe(false);
  });

  it("gives every preset in a section its own colour", () => {
    const byScope = new Map<string, string[]>();

    for (const preset of factorySectionPresets) {
      const key = `${preset.color.hue}:${preset.color.variation}`;
      const seen = byScope.get(preset.scope) ?? [];
      seen.push(key);
      byScope.set(preset.scope, seen);
    }

    for (const [scope, colors] of byScope) {
      expect(new Set(colors).size, `${scope} repeats a colour`).toBe(colors.length);
    }
  });

  it("continues a section's colour sequence when one is saved", () => {
    const used = factorySectionPresets.filter((preset) => preset.scope === "effect:blur");
    const next = pickSectionPresetColor(factorySectionPresets, "effect:blur");

    expect(used.some((preset) => preset.color.hue === next.hue && preset.color.variation === next.variation)).toBe(
      false,
    );
  });

  it("ships factory presets that only name parameters of their own section", () => {
    const wrong: string[] = [];

    for (const preset of factorySectionPresets) {
      for (const id of Object.keys(preset.values)) {
        const key = toParameterKey({ scope: preset.scope, modulatorIndex: 1 }, id);
        const def = parameterDefs[key];

        if (!def) {
          wrong.push(`${preset.id}: ${id} is not a parameter`);
          continue;
        }
        if (preset.scope.startsWith("effect:") && getEffectType(key) !== preset.scope.slice("effect:".length)) {
          wrong.push(`${preset.id}: ${id} belongs to another effect`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it("ships factory presets whose values are in range", () => {
    const wrong: string[] = [];

    for (const preset of factorySectionPresets) {
      for (const [id, value] of Object.entries(preset.values)) {
        const def = parameterDefs[toParameterKey({ scope: preset.scope, modulatorIndex: 1 }, id)];

        if (def?.kind === "number" && typeof value === "number" && (value < def.min || value > def.max)) {
          wrong.push(`${preset.id}: ${id} = ${value} outside ${def.min}–${def.max}`);
        }
        if (def?.kind === "options" && !def.options.some((option: { value: unknown }) => option.value === value)) {
          wrong.push(`${preset.id}: ${id} = ${value} is not an option`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });
});
