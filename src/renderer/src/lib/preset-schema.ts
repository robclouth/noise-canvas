// Zod schema for validating brush presets
import { parameterDefs } from "@renderer/parameters";
import { z } from "zod";

// Current preset version
export const CURRENT_PRESET_VERSION = 1;

export function createSchema() {
  return z.object({
    id: z.string(),
    name: z.string(),
    isFactory: z.boolean(),
    version: z.number().int().min(1).optional().default(1),
    parameters: z.object(
      Object.entries(parameterDefs).reduce(
        (acc, [key, parameterDef]) => {
          if (parameterDef.includeInPresets === true) {
            if (parameterDef.kind === "number") {
              acc[key] = z.number().min(parameterDef.min).max(parameterDef.max).optional();
            } else if (parameterDef.kind === "boolean") {
              acc[key] = z.boolean().optional();
            } else if (parameterDef.kind === "options") {
              acc[key] = z.any().refine((value) => parameterDef.options.some((opt) => opt.value === value), {
                message: `Invalid option for parameter ${key}`,
              });
            }
          }
          return acc;
        },
        {} as Record<string, z.ZodTypeAny>,
      ),
    ),
  });
}

export type PresetType = z.infer<ReturnType<typeof createSchema>>;

/**
 * Migrate a preset from an older version to the current version
 * This ensures backwards compatibility when preset structure changes
 */
export function migratePreset(data: any): any {
  const migratedData = { ...data };

  // Set version to current if not set
  if (!migratedData.version) {
    migratedData.version = CURRENT_PRESET_VERSION;
  }

  // Add migration logic here as versions increase
  // Example for future versions:
  // if (migratedData.version < 2) {
  //   // Migrate from v1 to v2
  //   migratedData.newField = defaultValue;
  //   migratedData.version = 2;
  // }
  // if (migratedData.version < 3) {
  //   // Migrate from v2 to v3
  //   if (migratedData.oldFieldName !== undefined) {
  //     migratedData.newFieldName = migratedData.oldFieldName;
  //     delete migratedData.oldFieldName;
  //   }
  //   migratedData.version = 3;
  // }

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
    return { success: true, data: validatedData };
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
