// Zod schema for validating brush presets
import { effects } from "@renderer/effects";
import { syncEffects } from "@renderer/effects/types";
import { getEffectType, isEffectParameter, parameterDefs } from "@renderer/parameters";
import { ParameterKey } from "@renderer/store/types";
import { z } from "zod";

// Current preset version
export const CURRENT_PRESET_VERSION = 6;

// Default macro values used for new brushes and migrated presets.
export const DEFAULT_MACRO_NAMES = ["Macro 1", "Macro 2", "Macro 3", "Macro 4"];
export const DEFAULT_MACRO_VALUES = [50, 50, 50, 50];

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
            acc[key] = z.any().refine(
              (value) => {
                if (value === undefined) return true;
                if ((key as ParameterKey) === "effects")
                  return (
                    Array.isArray(value) &&
                    value.every(
                      ({ effect, enabled, params }: { effect: string; enabled: boolean; params?: object }) =>
                        Object.keys(effects).includes(effect) &&
                        typeof enabled === "boolean" &&
                        (params === undefined || typeof params === "object"),
                    )
                  );
                return value === undefined || parameterDef.options.some((opt) => opt.value === value);
              },
              {
                message: `Invalid option for parameter ${key}`,
              },
            );
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

/**
 * Create a Zod schema for a single BrushStep
 */
function createBrushStepSchema() {
  return z
    .object({
      id: z.string(),
      name: z.string(),
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
  steps: Array<{ id: string; name: string } & Partial<Record<ParameterKey, any>>>;
  linkedParams: string[];
  macroNames: string[];
  macroValues: number[];
};

/**
 * Migrate a preset from an older version to the current version
 */
export function migratePreset(data: any): any {
  const migratedData = { ...data };

  // Set version to 1 if not set (old presets)
  if (!migratedData.version) {
    migratedData.version = 1;
  }

  // Migrate from v1 to v2: Extract step parameters into a steps array
  if (migratedData.version < 2) {
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

    migratedData.version = 2;
  }

  // Migrate from v2 to v3: Remove parameters field (all preset params are now in steps)
  if (migratedData.version < 3) {
    delete migratedData.parameters;
    migratedData.version = 3;
  }

  // Migrate from v3 to v4: Add linkedParams field
  if (migratedData.version < 4) {
    migratedData.linkedParams = [];
    migratedData.version = 4;
  }

  // Migrate from v4 to v5: Rename effectOrder to effects, extract per-instance params
  if (migratedData.version < 5) {
    migratedData.steps = (migratedData.steps || []).map((step: Record<string, unknown>) => {
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
    migratedData.macroNames = [...DEFAULT_MACRO_NAMES];
    migratedData.macroValues = [...DEFAULT_MACRO_VALUES];
    migratedData.version = 6;
  }

  // Ensure steps array exists
  if (!migratedData.steps || !Array.isArray(migratedData.steps)) {
    migratedData.steps = [{ id: crypto.randomUUID(), name: "Step 1" }];
  }

  // Sync effects in all steps to handle added/removed effect types
  migratedData.steps = migratedData.steps.map((step: Record<string, unknown>) => ({
    ...step,
    effects: syncEffects(
      step.effects as { id?: string; effect: string; enabled: boolean; params?: Record<string, unknown> }[] | undefined,
    ),
  }));

  return migratedData;
}

// Validation function with detailed error reporting and migration support
export function validatePreset(
  data: unknown,
): { success: true; data: PresetType } | { success: false; errors: string[] } {
  try {
    // First, try to migrate the data if needed
    const migratedData = migratePreset(data);

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
