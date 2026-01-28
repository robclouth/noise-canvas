// Zod schema for validating brush presets
import { effects } from "@renderer/effects";
import { parameterDefs } from "@renderer/parameters";
import { ParameterKey } from "@renderer/store/types";
import { z } from "zod";

// Current preset version
export const CURRENT_PRESET_VERSION = 2;

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
                if ((key as ParameterKey) === "effectOrder")
                  return (
                    Array.isArray(value) &&
                    value.every(
                      ({ effect, enabled }) => Object.keys(effects).includes(effect) && typeof enabled === "boolean",
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
    steps: z.array(createBrushStepSchema()).optional(),
    parameters: z.strictObject(
      Object.entries(parameterDefs).reduce(
        (acc, [key, parameterDef]) => {
          // Only include non-step preset parameters in the root parameters object
          if (parameterDef.includeInPresets === true && parameterDef.includeInStep !== true) {
            if (parameterDef.kind === "number") {
              acc[key] = z.number().optional();
            } else if (parameterDef.kind === "boolean") {
              acc[key] = z.boolean().optional();
            } else if (parameterDef.kind === "options") {
              acc[key] = z.any().refine(
                (value) => {
                  if (value === undefined) return true;
                  return value === undefined || parameterDef.options.some((opt) => opt.value === value);
                },
                {
                  message: `Invalid option for parameter ${key}`,
                },
              );
            } else if (parameterDef.kind === "string") {
              acc[key] = z.string().optional();
            }
          }
          return acc;
        },
        {} as Record<string, z.ZodTypeAny>,
      ),
    ),
  });
}

export type PresetType = Omit<z.infer<ReturnType<typeof createSchema>>, "parameters" | "steps"> & {
  parameters: Partial<Record<ParameterKey, any>>;
  steps?: Array<{ id: string; name: string } & Partial<Record<ParameterKey, any>>>;
};

/**
 * Migrate a preset from an older version to the current version
 * This ensures backwards compatibility when preset structure changes
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
    const rootParameters: Record<string, any> = {};

    // Separate step parameters from root parameters
    for (const [key, value] of Object.entries(oldParameters)) {
      const paramDef = parameterDefs[key as ParameterKey];
      if (paramDef?.includeInStep) {
        stepParameters[key] = value;
      } else {
        rootParameters[key] = value;
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

    // Keep only non-step parameters in the root
    migratedData.parameters = rootParameters;
    migratedData.version = 2;
  }

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
