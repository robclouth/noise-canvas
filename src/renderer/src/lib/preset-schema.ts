// Zod schema for validating brush presets
import { effects } from "@renderer/effects";
import { syncEffects } from "@renderer/effects/types";
import {
  getEffectType,
  isEffectParameter,
  isStepParameter,
  isStorableOptionValue,
  parameterDefs,
} from "@renderer/parameters";
import { ParameterKey, type Brush } from "@renderer/store/types";
import { z } from "zod";

// Current preset version
export const CURRENT_PRESET_VERSION = 6;

// Default macro values used for new brushes and migrated presets.
export const DEFAULT_MACRO_NAMES = ["Macro 1", "Macro 2", "Macro 3", "Macro 4"];
export const DEFAULT_MACRO_VALUES = [50, 50, 50, 50];

/** One entry of a step's effect chain. Built lazily, so the registry is loaded. */
function createEffectItemSchema() {
  return z.object({
    id: z.string().optional(),
    effect: z.string().refine((effect) => effect in effects),
    enabled: z.boolean(),
    params: z.record(z.string(), z.unknown()).optional(),
  });
}

/**
 * Create a Zod schema for step parameters (parameters with includeInStep: true)
 */
function createStepParametersSchema() {
  return z.strictObject(
    Object.entries(parameterDefs).reduce(
      (acc, [key, parameterDef]) => {
        if (parameterDef.includeInStep === true) {
          if (parameterDef.kind === "number") {
            acc[key] = z.number().optional();
          } else if (parameterDef.kind === "boolean") {
            acc[key] = z.boolean().optional();
          } else if (parameterDef.kind === "options") {
            acc[key] =
              (key as ParameterKey) === "effects"
                ? z.array(createEffectItemSchema()).optional()
                : z.any().refine((value) => isStorableOptionValue(key as ParameterKey, value), {
                    message: `Invalid option for parameter ${key}`,
                  });
          } else if (parameterDef.kind === "string") {
            acc[key] = z.string().optional();
          } else if (parameterDef.kind === "file") {
            acc[key] = z.union([z.null(), z.strictObject({ path: z.string() })]).optional();
          }
        }
        return acc;
      },
      {} as Record<string, z.ZodTypeAny>,
    ),
  );
}

export const brushColorSchema = z.object({ hue: z.string(), variation: z.number() });
const lockedOffsetSchema = z.object({ beats: z.number(), pitch: z.number() }).nullish();

/**
 * Create a Zod schema for a single BrushStep
 */
export function createBrushStepSchema() {
  return z
    .object({
      id: z.string(),
      name: z.string(),
      color: brushColorSchema.optional(),
      // Recomputed at the start of every stroke; stored only because a step is
      // persisted whole.
      lockedOffset: lockedOffsetSchema,
    })
    .merge(createStepParametersSchema());
}

/**
 * Create the main preset schema
 */
export function createSchema() {
  return z.strictObject({
    id: z.string(),
    name: z.string(),
    isFactory: z.boolean(),
    version: z.number().int().min(1).optional().default(CURRENT_PRESET_VERSION),
    // Palette colour the brush takes when added from this preset.
    color: brushColorSchema.optional(),
    steps: z.array(createBrushStepSchema()),
    linkedParams: z.array(z.string()).optional().default([]),
    macroNames: z
      .array(z.string())
      .length(4)
      .optional()
      .default([...DEFAULT_MACRO_NAMES]),
    macroValues: z
      .array(z.number())
      .length(4)
      .optional()
      .default([...DEFAULT_MACRO_VALUES]),
  });
}

export type PresetType = Omit<z.infer<ReturnType<typeof createSchema>>, "steps"> & {
  steps: Array<
    { id: string; name: string; color?: { hue: string; variation: number } } & Partial<Record<ParameterKey, any>>
  >;
  linkedParams: string[];
  macroNames: string[];
  macroValues: number[];
};

/** True when no library preset holds this brush, or its settings differ from the one that does. */
export function isBrushUnsaved(brush: Brush, presets: readonly PresetType[]): boolean {
  if (brush.libraryId === null) return true;

  const preset = presets.find((candidate) => candidate.id === brush.libraryId);
  if (!preset) return true;

  const presetSnapshot = {
    steps: preset.steps ?? [],
    linkedParams: preset.linkedParams ?? [],
    macroNames: preset.macroNames ?? [...DEFAULT_MACRO_NAMES],
    macroValues: preset.macroValues ?? [...DEFAULT_MACRO_VALUES],
  };
  const brushSnapshot = {
    steps: brush.steps.map(sanitizeStepParams),
    linkedParams: brush.linkedParams,
    macroNames: brush.macroNames,
    macroValues: brush.macroValues,
  };
  return JSON.stringify(presetSnapshot) !== JSON.stringify(brushSnapshot);
}

// --- Repair ---
//
// A preset on disk was written by an older build, so any part of it can name a
// parameter, option or field the app has since changed. Repair drops or rebuilds
// whatever the schema would reject, which leaves the parameter reading its
// default, so a preset only ever loses the setting that moved rather than
// failing whole and vanishing from the library. Every rule is read off the
// schema, so a change to the schema carries into the repair with it.

let stepShape: Record<string, z.ZodTypeAny> | null = null;
let presetShape: Record<string, z.ZodTypeAny> | null = null;

const getStepShape = () => (stepShape ??= createStepParametersSchema().shape);
const getPresetShape = () => (presetShape ??= createSchema().shape);

/**
 * The keys a step carries that no step parameter owns: its own identity, and
 * the effect chain, which `syncEffects` repairs item by item rather than
 * failing whole.
 */
const STEP_OWN_KEYS = new Set(["id", "name", "color", "lockedOffset", "effects"]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Drops every step key the schema would reject: a parameter that no longer
 * exists, an option that has been retired, a value whose type no longer matches
 * the parameter's kind, or a null in a kind that has no null form. Returns the
 * input unchanged when there is nothing to drop.
 */
export function sanitizeStepParams<T extends Record<string, unknown>>(step: T): T {
  const shape = getStepShape();
  let cleaned: T | null = null;
  for (const [key, value] of Object.entries(step)) {
    if (STEP_OWN_KEYS.has(key)) continue;
    // A JSON key like "__proto__" resolves off the prototype, so only an own
    // field of the shape counts as a parameter the schema knows.
    if (Object.hasOwn(shape, key) && shape[key].safeParse(value).success) continue;
    cleaned ??= { ...step };
    delete cleaned[key];
  }
  return cleaned ?? step;
}

/**
 * An effect instance's own parameter values, minus anything the schema would
 * reject. A step reads this layer ahead of its own, so a value the step level
 * drops has to go from here too or the retired one still reaches the shader.
 */
export function sanitizeEffectParams<T extends Record<string, unknown>>(params: T): T {
  const shape = getStepShape();
  let cleaned: T | null = null;
  for (const [key, value] of Object.entries(params)) {
    if (Object.hasOwn(shape, key) && shape[key].safeParse(value).success) continue;
    cleaned ??= { ...params };
    delete cleaned[key];
  }
  return cleaned ?? params;
}

/** One step with its own identity intact and every unusable parameter dropped. */
function repairStep(step: unknown, index: number): Record<string, unknown> {
  const source = asRecord(step);
  const repaired: Record<string, unknown> = { ...sanitizeStepParams(source) };

  if (typeof repaired.id !== "string") repaired.id = crypto.randomUUID();
  if (typeof repaired.name !== "string") repaired.name = `Step ${index + 1}`;
  if (repaired.color !== undefined && !brushColorSchema.safeParse(repaired.color).success) delete repaired.color;
  if (repaired.lockedOffset !== undefined && !lockedOffsetSchema.safeParse(repaired.lockedOffset).success) {
    delete repaired.lockedOffset;
  }

  repaired.effects = syncEffects(source.effects as Parameters<typeof syncEffects>[0]).map((item) => ({
    ...item,
    params: sanitizeEffectParams(item.params),
  }));
  return repaired;
}

/** A list the length of `defaults`, taking each entry from `value` where it is usable. */
function repairFixedArray<T>(value: unknown, defaults: readonly T[], isEntry: (entry: unknown) => boolean): T[] {
  const source = Array.isArray(value) ? value : [];
  return defaults.map((fallback, index) => (isEntry(source[index]) ? (source[index] as T) : fallback));
}

/**
 * Bring anything preset-shaped up to something the schema accepts. Only a value
 * that is not an object at all is beyond repair.
 */
export function repairPreset(data: unknown, fallbackId?: string): Record<string, unknown> {
  const source = asRecord(data);
  const shape = getPresetShape();
  const repaired: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(shape, key)) repaired[key] = value;
  }

  // The file is named for the id, so a preset that lost its own has to take the
  // one its filename gives, or saving it writes a second file beside it.
  if (typeof repaired.id !== "string") repaired.id = fallbackId ?? crypto.randomUUID();
  if (typeof repaired.name !== "string") repaired.name = "Untitled";
  if (typeof repaired.isFactory !== "boolean") repaired.isFactory = false;
  if (repaired.color !== undefined && !brushColorSchema.safeParse(repaired.color).success) delete repaired.color;

  repaired.macroNames = repairFixedArray(repaired.macroNames, DEFAULT_MACRO_NAMES, (n) => typeof n === "string");
  repaired.macroValues = repairFixedArray(
    repaired.macroValues,
    DEFAULT_MACRO_VALUES,
    (v) => typeof v === "number" && Number.isFinite(v),
  );
  repaired.linkedParams = (Array.isArray(repaired.linkedParams) ? repaired.linkedParams : []).filter(
    (key): key is string => typeof key === "string" && isStepParameter(key as ParameterKey),
  );

  const steps = Array.isArray(repaired.steps) && repaired.steps.length > 0 ? repaired.steps : [{}];
  repaired.steps = steps.map(repairStep);

  return repaired;
}

/**
 * Migrate a preset from an older version to the current version
 */
export function migratePreset(data: any, fallbackId?: string): any {
  const migratedData = { ...data };

  // Anything that is not a version number reads as the oldest, so every
  // migration below is offered the preset. Each one converts a shape rather
  // than trusting the number, because a file whose version cannot be read still
  // holds everything a current one does.
  if (!Number.isInteger(migratedData.version) || migratedData.version < 1) {
    migratedData.version = 1;
  }

  // Migrate from v1 to v2: Extract step parameters into a steps array
  if (migratedData.version < 2 && !Array.isArray(migratedData.steps)) {
    const oldParameters = migratedData.parameters || {};
    const stepParameters: Record<string, any> = {};

    // Extract step parameters
    for (const [key, value] of Object.entries(oldParameters)) {
      const paramDef = parameterDefs[key as ParameterKey];
      if (paramDef?.includeInStep) {
        stepParameters[key] = value;
      }
    }

    // Create a single step with the extracted parameters
    migratedData.steps = [
      {
        id: crypto.randomUUID(),
        name: "Step 1",
        ...stepParameters,
      },
    ];
  }
  migratedData.version = Math.max(migratedData.version, 2);

  // Migrate from v2 to v3: Remove parameters field (all preset params are now in steps)
  if (migratedData.version < 3) {
    delete migratedData.parameters;
    migratedData.version = 3;
  }

  // Migrate from v3 to v4: Add linkedParams field
  if (migratedData.version < 4 && !Array.isArray(migratedData.linkedParams)) {
    migratedData.linkedParams = [];
  }
  migratedData.version = Math.max(migratedData.version, 4);

  // Migrate from v4 to v5: Rename effectOrder to effects, extract per-instance params
  if (migratedData.version < 5) {
    migratedData.steps = (migratedData.steps || []).map((step: Record<string, unknown>) => {
      // A step that already lists its effects is past this migration, whatever
      // the version field says.
      if (Array.isArray(step?.effects)) return step;
      const newStep = { ...step };

      // Get effectOrder array (may be undefined in old presets)
      const effectOrder = step.effectOrder as { id?: string; effect: string; enabled: boolean }[] | undefined;

      // Convert effectOrder to effects with per-instance params
      const effects = (effectOrder || []).map((item) => {
        const effectType = item.effect;
        const params: Record<string, unknown> = {};

        // Extract effect-specific parameters from step level into the effect's params
        for (const [key, value] of Object.entries(step)) {
          if (isEffectParameter(key as ParameterKey) && getEffectType(key as ParameterKey) === effectType) {
            params[key] = value;
            // Remove from step level
            delete newStep[key];
          }
        }

        return {
          id: item.id ?? crypto.randomUUID(),
          effect: effectType,
          enabled: item.enabled,
          params,
        };
      });

      // Replace effectOrder with effects
      delete newStep.effectOrder;
      newStep.effects = effects;

      return newStep;
    });

    migratedData.version = 5;
  }

  // Migrate from v5 to v6: Initialise macro names/values on the brush.
  if (migratedData.version < 6) {
    if (!Array.isArray(migratedData.macroNames)) migratedData.macroNames = [...DEFAULT_MACRO_NAMES];
    if (!Array.isArray(migratedData.macroValues)) migratedData.macroValues = [...DEFAULT_MACRO_VALUES];
  }
  migratedData.version = Math.max(migratedData.version, CURRENT_PRESET_VERSION);

  return repairPreset(migratedData, fallbackId);
}

// Validation function with detailed error reporting and migration support
export function validatePreset(
  data: unknown,
  fallbackId?: string,
): { success: true; data: PresetType } | { success: false; errors: string[] } {
  // Repair rebuilds anything preset-shaped, so without this a stray .json in
  // the presets folder would load as a blank brush. A preset holds its steps,
  // or, before v2, the parameters they were made from.
  const record = data as Record<string, unknown> | null;
  if (typeof data !== "object" || record === null || Array.isArray(data)) {
    return { success: false, errors: ["Not a preset"] };
  }
  if (!Array.isArray(record.steps) && typeof record.parameters !== "object") {
    return { success: false, errors: ["Not a preset: it holds no steps"] };
  }
  try {
    // First, try to migrate the data if needed
    const migratedData = migratePreset(data, fallbackId);

    // Then validate against the schema
    const PresetSchema = createSchema();
    const validatedData = PresetSchema.parse(migratedData);
    return { success: true, data: validatedData as PresetType };
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
