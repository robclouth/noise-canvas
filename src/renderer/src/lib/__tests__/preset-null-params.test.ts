import { describe, expect, it, vi } from "vitest";

// Mirrors presets.test.ts: the real registry and the factory preset list pull a
// cycle through preset-schema that the browser test runtime cannot resolve.
vi.mock("@renderer/effects", () => ({
  effects: { transform: {}, dynamics: {}, blur: {}, synthesize: {}, passthrough: {} },
}));
vi.mock("@renderer/lib/factory-presets", () => ({ factoryPresets: [] }));

import { parameterDefs, sanitizeStepParams } from "../../parameters";
import { CURRENT_PRESET_VERSION, validatePreset } from "../preset-schema";
import type { ParameterKey } from "../../store/types";

/**
 * Only file parameters carry null as their unset value. Writing null into any
 * other kind gets past the store, which does not type-check what it is handed,
 * and then fails preset validation at the point the user tries to save — long
 * after the control that wrote it.
 */

const TEXTURE_PATH = "modulator1TexturePath" as ParameterKey;
const SOURCE_FILE = "sourceFile" as ParameterKey;

function presetWithStep(step: Record<string, unknown>) {
  return {
    id: "p1",
    name: "Test",
    isFactory: false,
    version: CURRENT_PRESET_VERSION,
    color: { hue: "blue", variation: 0 },
    steps: [{ id: "s1", name: "Step 1", ...step }],
    linkedParams: [],
    macroNames: ["Macro 1", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [50, 50, 50, 50],
  };
}

describe("step parameters holding null", () => {
  it("declares the texture path a string, so its unset value is the empty string", () => {
    const def = parameterDefs[TEXTURE_PATH];
    expect(def).toBeDefined();
    expect(def?.kind).toBe("string");
    expect(def?.default).toBe("");
  });

  it("saves a preset whose texture path was left at its default", () => {
    const result = validatePreset(presetWithStep({ [TEXTURE_PATH]: "" }));
    expect(result.success).toBe(true);
  });

  it("saves a preset carrying a null texture path from an older session", () => {
    const result = validatePreset(presetWithStep({ [TEXTURE_PATH]: null }));
    expect(result.success).toBe(true);
  });

  it("keeps a null source file, which is how a file parameter reads as unset", () => {
    const result = validatePreset(presetWithStep({ [SOURCE_FILE]: null }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.steps[0][SOURCE_FILE]).toBeNull();
  });
});

describe("sanitizeStepParams", () => {
  it("drops a null where the parameter kind has no null form", () => {
    expect(sanitizeStepParams({ [TEXTURE_PATH]: null })).toEqual({});
  });

  it("leaves a null file parameter alone", () => {
    expect(sanitizeStepParams({ [SOURCE_FILE]: null })).toEqual({ [SOURCE_FILE]: null });
  });

  it("returns the same object when there is nothing to drop", () => {
    const step = { [TEXTURE_PATH]: "img.png", id: "s1" };
    expect(sanitizeStepParams(step)).toBe(step);
  });

  it("leaves keys it knows nothing about", () => {
    const step = { id: "s1", name: "Step 1", color: { hue: "blue", variation: 0 } };
    expect(sanitizeStepParams(step)).toBe(step);
  });
});
