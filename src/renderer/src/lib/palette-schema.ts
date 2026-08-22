// Zod schema for validating palettes: a named, ordered set of brushes.
import { UNTITLED_PALETTE_NAME } from "@renderer/store/palette-id";
import type { Brush } from "@renderer/store/types";
import { z } from "zod";
import { pickNextBrushColor } from "./colors";
import {
  brushColorSchema,
  createBrushStepSchema,
  DEFAULT_MACRO_NAMES,
  DEFAULT_MACRO_VALUES,
  migratePreset,
} from "./preset-schema";

export const CURRENT_PALETTE_VERSION = 1;

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
    brushes: z.array(createPaletteBrushSchema()),
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
export function migratePalette(data: unknown, fallbackId?: string): unknown {
  if (typeof data !== "object" || data === null) return data;
  const source = data as Record<string, unknown>;
  const shape = createPaletteSchema().shape;
  const migrated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    // Own fields only: a JSON key like "__proto__" resolves off the prototype.
    if (Object.hasOwn(shape, key)) migrated[key] = value;
  }

  if (!Number.isInteger(migrated.version) || (migrated.version as number) < 1) {
    migrated.version = CURRENT_PALETTE_VERSION;
  }
  // The file is named for the id, so a palette that lost its own takes the one
  // its filename gives rather than a fresh one on every launch.
  if (typeof migrated.id !== "string") migrated.id = fallbackId ?? crypto.randomUUID();
  if (typeof migrated.name !== "string") migrated.name = UNTITLED_PALETTE_NAME;
  if (typeof migrated.isFactory !== "boolean") migrated.isFactory = false;

  const brushes = Array.isArray(migrated.brushes) ? migrated.brushes : [];
  const taken: Brush["color"][] = [];
  migrated.brushes = brushes
    .filter((brush: unknown) => typeof brush === "object" && brush !== null && !Array.isArray(brush))
    .map((brush: Record<string, unknown>) => {
      const asPreset = migratePreset({ ...brush, version: brush.version ?? 6 }) as Record<string, unknown>;
      delete asPreset.version;

      // The preset repair works to the preset schema, which has no room for what
      // only a palette brush carries and no need of what only a preset carries.
      delete asPreset.isFactory;
      asPreset.hotkey = typeof brush.hotkey === "string" ? brush.hotkey : null;
      asPreset.libraryId = typeof brush.libraryId === "string" ? brush.libraryId : null;

      const color = brushColorSchema.safeParse(asPreset.color);
      asPreset.color = color.success ? color.data : pickNextBrushColor(taken);
      taken.push(asPreset.color as Brush["color"]);
      return asPreset;
    });

  return migrated;
}

export function validatePalette(
  data: unknown,
  fallbackId?: string,
): { success: true; data: PaletteType } | { success: false; errors: string[] } {
  // An emptied palette is a real palette and keeps its brushes list; a stray
  // .json in the palettes folder has none, and must not become one.
  const record = data as Record<string, unknown> | null;
  if (typeof data !== "object" || record === null || Array.isArray(data) || !Array.isArray(record.brushes)) {
    return { success: false, errors: ["Not a palette"] };
  }
  try {
    const parsed = createPaletteSchema().parse(migratePalette(data, fallbackId));
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
  return brushes.map(brushFingerprint).join("\n");
}

// Brush objects are replaced, never mutated, so a brush's fingerprint is
// cached against its identity: a parameter edit re-serialises only the brush
// it changed.
const brushFingerprints = new WeakMap<PaletteBrush, string>();

function brushFingerprint(brush: PaletteBrush): string {
  const cached = brushFingerprints.get(brush);
  if (cached !== undefined) return cached;
  const fingerprint = JSON.stringify({
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
  });
  brushFingerprints.set(brush, fingerprint);
  return fingerprint;
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
