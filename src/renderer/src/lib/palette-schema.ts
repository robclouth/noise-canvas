// Zod schema for validating palettes: a named, ordered set of brushes.
import type { Brush } from "@renderer/store/types";
import { z } from "zod";
import { createBrushStepSchema, DEFAULT_MACRO_NAMES, DEFAULT_MACRO_VALUES, migratePreset } from "./preset-schema";

export const CURRENT_PALETTE_VERSION = 1;

const brushColorSchema = z.object({ hue: z.string(), variation: z.number() });

function createPaletteBrushSchema() {
  return z.strictObject({
    id: z.string(),
    name: z.string(),
    color: brushColorSchema,
    hotkey: z.string().nullable().default(null),
    steps: z.array(createBrushStepSchema()),
    linkedParams: z.array(z.string()).default([]),
    libraryId: z.string().nullable().default(null),
    macroNames: z
      .array(z.string())
      .length(4)
      .default([...DEFAULT_MACRO_NAMES]),
    macroValues: z
      .array(z.number())
      .length(4)
      .default([...DEFAULT_MACRO_VALUES]),
  });
}

export function createPaletteSchema() {
  return z.strictObject({
    id: z.string(),
    name: z.string(),
    isFactory: z.boolean(),
    version: z.number().int().min(1).optional().default(CURRENT_PALETTE_VERSION),
    brushes: z.array(createPaletteBrushSchema()).min(1),
  });
}

/** A brush as a palette file stores it: everything but the group it is open in. */
export type PaletteBrush = Omit<Brush, "paletteId">;

export type PaletteType = {
  id: string;
  name: string;
  isFactory: boolean;
  version: number;
  brushes: PaletteBrush[];
};

/** Open brushes reduced to their stored form, dropping the group they sit in. */
export function toStoredBrushes(brushes: readonly Brush[]): PaletteBrush[] {
  return brushes.map((brush) => {
    const stored = structuredClone(brush) as Partial<Brush>;
    delete stored.paletteId;
    return stored as PaletteBrush;
  });
}

/**
 * Bring a stored palette up to the current version. Each brush inside runs
 * through the preset migration, so a palette written before an effect changed
 * loads the same way a preset of that age does.
 */
export function migratePalette(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const migrated = { ...(data as Record<string, unknown>) };

  if (!migrated.version) migrated.version = CURRENT_PALETTE_VERSION;
  // Palettes carried an accent colour before they became folders.
  delete migrated.color;

  const brushes = Array.isArray(migrated.brushes) ? migrated.brushes : [];
  migrated.brushes = brushes.map((brush: unknown) => {
    const record = brush as Record<string, unknown>;
    const asPreset = migratePreset({ ...record, version: record.version ?? 6 }) as Record<string, unknown>;
    delete asPreset.version;
    return asPreset;
  });

  return migrated;
}

export function validatePalette(
  data: unknown,
): { success: true; data: PaletteType } | { success: false; errors: string[] } {
  try {
    const parsed = createPaletteSchema().parse(migratePalette(data));
    return { success: true, data: parsed as PaletteType };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        errors: error.issues.map((issue) => {
          const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
          return `${path}${issue.message}`;
        }),
      };
    }
    return { success: false, errors: ["Unknown validation error"] };
  }
}

/** The brushes a palette holds, stripped of anything not stored. */
export function serializePalette(palette: PaletteType): string {
  return JSON.stringify(
    {
      id: palette.id,
      name: palette.name,
      isFactory: false,
      version: CURRENT_PALETTE_VERSION,
      brushes: palette.brushes,
    },
    null,
    2,
  );
}

/**
 * The comparison a dirty check runs on. Brush and step ids are minted fresh
 * every time a palette opens, so both are left out — only what a palette
 * describes counts, never which copy of it this is.
 */
export function paletteFingerprint(brushes: readonly PaletteBrush[]): string {
  return JSON.stringify(
    brushes.map((brush) => ({
      name: brush.name,
      color: brush.color,
      hotkey: brush.hotkey,
      steps: brush.steps.map((step) => {
        const withoutId = { ...step } as Partial<PaletteBrush["steps"][number]>;
        delete withoutId.id;
        return withoutId;
      }),
      linkedParams: brush.linkedParams,
      libraryId: brush.libraryId,
      macroNames: brush.macroNames,
      macroValues: brush.macroValues,
    })),
  );
}

export function makePaletteId(name: string, existingIds: Set<string>): string {
  let safe = name
    .replace(/[^a-zA-Z0-9\s\-_]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (!safe) safe = "palette";

  let id = `${safe}-${Date.now()}`;
  let counter = 1;
  while (existingIds.has(id)) {
    id = `${safe}-${Date.now()}-${counter}`;
    counter++;
  }
  return id;
}
