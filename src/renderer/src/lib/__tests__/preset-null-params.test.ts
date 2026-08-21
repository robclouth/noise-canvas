import { describe, expect, it, vi } from "vitest";

// Mirrors presets.test.ts: the real registry and the factory preset list pull a
// cycle through preset-schema that the browser test runtime cannot resolve.
vi.mock("@renderer/effects", () => ({
  effects: { transform: {}, dynamics: {}, blur: {}, synthesize: {}, passthrough: {} },
}));
vi.mock("@renderer/lib/factory-presets", () => ({ factoryPresets: [] }));

import { parameterDefs } from "../../parameters";
import { CURRENT_PRESET_VERSION, sanitizeStepParams, validatePreset } from "../preset-schema";
import type { ParameterKey } from "../../store/types";

/**
 * Only file parameters carry null as their unset value. Writing null into any
 * other kind gets past the store, which does not type-check what it is handed,
 * and then fails preset validation at the point the user tries to save — long
 * after the control that wrote it.
 */

const TEXTURE_PATH = "modulator1TexturePath" as ParameterKey;
const SOURCE_FILE = "sourceFile" as ParameterKey;
const NON_STEP_PARAM = "limiterEnabled" as ParameterKey;
const OPTION_PARAM = "algorithm" as ParameterKey;

function optionValues(): unknown[] {
  const def = parameterDefs[OPTION_PARAM];
  if (def?.kind !== "options") throw new Error(`${OPTION_PARAM} is not an options parameter`);
  return def.options.map((option) => option.value);
}

/** The first value the parameter offers. */
function offeredOptionValue(): unknown {
  return optionValues()[0];
}

/** A number the parameter does not offer, standing in for an option since removed. */
function retiredOptionValue(): number {
  const offered = optionValues();
  let value = 0;
  while (offered.includes(value)) value++;
  return value;
}

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

  it("leaves the step's own id, name and colour alone", () => {
    const step = { id: "s1", name: "Step 1", color: { hue: "blue", variation: 0 } };
    expect(sanitizeStepParams(step)).toBe(step);
  });

  it("drops a key whose parameter no longer exists", () => {
    expect(sanitizeStepParams({ id: "s1", transmuteMode: 0 })).toEqual({ id: "s1" });
  });

  it("drops a parameter that is not a step parameter", () => {
    expect(parameterDefs[NON_STEP_PARAM]?.includeInStep).not.toBe(true);
    expect(sanitizeStepParams({ [NON_STEP_PARAM]: 1 })).toEqual({});
  });

  it("drops an option value that is no longer offered", () => {
    expect(sanitizeStepParams({ [OPTION_PARAM]: retiredOptionValue() })).toEqual({});
  });

  it("keeps an option value that is still offered", () => {
    const value = offeredOptionValue();
    expect(sanitizeStepParams({ [OPTION_PARAM]: value })).toEqual({ [OPTION_PARAM]: value });
  });

  it("keeps the effect chain, which is a list rather than one of the options", () => {
    const step = { effects: [{ id: "e1", effect: "transform", enabled: true, params: {} }] };
    expect(sanitizeStepParams(step)).toBe(step);
  });
});

/**
 * Steps are validated against the current parameter list, so anything left
 * behind by a removed parameter or a retired option would otherwise fail the
 * whole preset and drop it from the library.
 */
describe("presets written before a parameter or option was removed", () => {
  it("loads a preset carrying a step key with no parameter left", () => {
    const result = validatePreset(presetWithStep({ transmuteMode: 0 }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.steps[0]).not.toHaveProperty("transmuteMode");
  });

  it("loads a preset whose option value has since been retired", () => {
    const result = validatePreset(presetWithStep({ [OPTION_PARAM]: retiredOptionValue() }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.steps[0]).not.toHaveProperty(OPTION_PARAM);
  });
});
