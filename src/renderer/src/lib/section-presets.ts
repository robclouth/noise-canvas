import type { EffectType } from "@renderer/effects/types";
import { pickNextBrushColor } from "@renderer/lib/colors";
import { parameterDefs, type FileParameterValue } from "@renderer/parameters";
import type { BrushColor, ParameterKey } from "@renderer/store/types";
import { z } from "zod";

/** The group of parameters one preset covers. */
export type SectionScope = `effect:${EffectType}` | "modulator";

/** The folder under Presets/ that a scope's user files live in. */
export type SectionFolder = "effects" | "modulators";

/**
 * Where a preset's values are written. `effectId` names the effect instance for
 * an effect scope, `modulatorIndex` the 1-based modulator for the modulator one.
 */
export type SectionTarget = {
  scope: SectionScope;
  effectId?: string;
  modulatorIndex?: number;
};

export type SectionPreset = {
  id: string;
  scope: SectionScope;
  name: string;
  description: string;
  isFactory: boolean;
  /** Palette colour of the bar down the left of the preset's row. */
  color: BrushColor;
  values: Record<string, unknown>;
};

/** The colour a new preset takes, spread across the palette within its scope. */
export function pickSectionPresetColor(existing: SectionPreset[], scope: SectionScope): BrushColor {
  return pickNextBrushColor(existing.filter((preset) => preset.scope === scope).map((preset) => preset.color));
}

export const effectScope = (effect: EffectType): SectionScope => `effect:${effect}`;

export function folderFor(scope: SectionScope): SectionFolder {
  return scope === "modulator" ? "modulators" : "effects";
}

const MODULATOR_PREFIX = /^modulator\d+/;

/**
 * A parameter key as a preset stores it. Modulator keys lose the modulator they
 * came from, so one preset loads into any of the three.
 */
export function toStorageId(scope: SectionScope, key: ParameterKey): string {
  return scope === "modulator" ? key.replace(MODULATOR_PREFIX, "") : key;
}

/** A stored id resolved back to a parameter key on `target`. */
export function toParameterKey(target: SectionTarget, id: string): ParameterKey {
  if (target.scope !== "modulator") return id as ParameterKey;
  return `modulator${target.modulatorIndex ?? 1}${id}` as ParameterKey;
}

/**
 * Every value applying `preset` writes: the ones it names, and each key it
 * omits at that parameter's default, so the section always ends in the state
 * the preset describes. A file parameter the preset does not name is left out
 * altogether, so whatever is loaded stays loaded.
 */
export function resolveSectionPreset(
  preset: SectionPreset,
  target: SectionTarget,
  keys: ParameterKey[],
): { key: ParameterKey; value: unknown }[] {
  const resolved: { key: ParameterKey; value: unknown }[] = [];

  for (const key of keys) {
    const id = toStorageId(target.scope, key);
    if (Object.prototype.hasOwnProperty.call(preset.values, id)) {
      resolved.push({ key, value: preset.values[id] });
    } else if (parameterDefs[key]?.kind !== "file") {
      resolved.push({ key, value: parameterDefs[key]?.default });
    }
  }

  return resolved;
}

/** The paths among resolved values, which applying a preset opens alongside it. */
export function referencedFilePaths(resolved: { key: ParameterKey; value: unknown }[]): string[] {
  const paths = new Set<string>();

  for (const { key, value } of resolved) {
    if (parameterDefs[key]?.kind !== "file") continue;
    const path = (value as FileParameterValue)?.path;
    if (path) paths.add(path);
  }

  return [...paths];
}

/** The current value of every key in the section, keyed for storage. */
export function captureSectionValues(
  scope: SectionScope,
  keys: ParameterKey[],
  read: (key: ParameterKey) => unknown,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    values[toStorageId(scope, key)] = read(key);
  }
  return values;
}

/** A filename-safe id for a new user preset, unique against `existingIds`. */
export function makeSectionPresetId(scope: SectionScope, name: string, existingIds: Set<string>): string {
  const slug =
    name
      .replace(/[^a-zA-Z0-9\s\-_]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "preset";

  const base = `${scope.replace(":", "-")}-${slug}`;
  let id = base;
  let counter = 1;
  while (existingIds.has(id)) {
    id = `${base}-${counter}`;
    counter++;
  }
  return id;
}

const sectionPresetSchema = z.strictObject({
  id: z.string(),
  scope: z.string(),
  name: z.string(),
  description: z.string().optional().default(""),
  color: z.strictObject({ hue: z.string(), variation: z.number() }),
  values: z.record(z.string(), z.unknown()),
});

/** Parses one user preset off disk. Files never carry `isFactory`. */
export function validateSectionPreset(data: unknown): { success: true; data: SectionPreset } | { success: false } {
  const result = sectionPresetSchema.safeParse(data);
  if (!result.success) return { success: false };
  return { success: true, data: { ...result.data, scope: result.data.scope as SectionScope, isFactory: false } };
}

/** The shape written to disk — the runtime-only `isFactory` flag is dropped. */
export function serializeSectionPreset(preset: SectionPreset): string {
  const { id, scope, name, description, color, values } = preset;
  return JSON.stringify({ id, scope, name, description, color, values }, null, 2);
}
