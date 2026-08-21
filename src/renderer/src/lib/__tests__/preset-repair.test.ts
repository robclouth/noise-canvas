import { describe, expect, it, vi } from "vitest";

// Mirrors presets.test.ts: the real registry and the factory preset list pull a
// cycle through preset-schema that the browser test runtime cannot resolve.
vi.mock("@renderer/effects", () => ({
  effects: { transform: {}, dynamics: {}, blur: {}, synthesize: {}, passthrough: {} },
}));
vi.mock("@renderer/lib/factory-presets", () => ({ factoryPresets: [] }));
vi.mock("@renderer/lib/factory-palettes", () => ({ factoryPalettes: [] }));

import { CURRENT_PRESET_VERSION, sanitizeStepParams, validatePreset } from "../preset-schema";
import { CURRENT_PALETTE_VERSION, validatePalette } from "../palette-schema";

/**
 * A preset on disk was written by an older build, so any part of it can name a
 * parameter, option or field the app has since changed. Every case below is a
 * shape a preset file can arrive in. Loading must recover from all of them, and
 * must lose nothing but the setting the damage touched — a preset that loads
 * blank is as bad as one that does not load, because the user then saves over
 * the real one with it.
 */

/** `affects` names the parts this damage may change. Nothing else may move. */
type Damage = { apply: (brush: Record<string, any>) => void; affects?: string[] };

const STEP_PARTS = ["stepNames", "intensities", "effects", "effectParams", "accumulate"];

function validBrush(): Record<string, any> {
  return {
    id: "p1",
    name: "Test",
    color: { hue: "blue", variation: 0 },
    steps: [
      {
        id: "s1",
        name: "Lead",
        brushIntensity: 42,
        accumulate: true,
        effects: [{ id: "e1", effect: "transform", enabled: true, params: { transformScaleTime: 2 } }],
      },
      { id: "s2", name: "Tail", brushIntensity: 7, effects: [] },
    ],
    linkedParams: ["brushIntensity"],
    macroNames: ["Air", "Grit", "Macro 3", "Macro 4"],
    macroValues: [10, 20, 30, 40],
  };
}

function validPreset(): Record<string, any> {
  return { ...validBrush(), isFactory: false, version: CURRENT_PRESET_VERSION };
}

/** Everything a load must carry through, part by part, so a loss names itself. */
function parts(brush: Record<string, any>): Record<string, unknown> {
  const steps: any[] = Array.isArray(brush.steps) ? brush.steps : [];
  return {
    name: brush.name,
    color: brush.color,
    stepNames: steps.map((step) => step.name),
    intensities: steps.map((step) => step.brushIntensity),
    effects: steps.map((step) => (step.effects ?? []).map((e: any) => e.effect)),
    effectParams: steps.map((step) => (step.effects ?? []).map((e: any) => e.params)),
    accumulate: steps[0]?.accumulate,
    macroNames: brush.macroNames,
    macroValues: brush.macroValues,
    linkedParams: brush.linkedParams,
  };
}

/** Asserts every part the damage did not claim survived the load intact. */
function expectOnlyAffected(loaded: Record<string, any>, before: Record<string, any>, affects: string[]) {
  const after = parts(loaded);
  const baseline = parts(before);
  for (const key of Object.keys(baseline)) {
    if (affects.includes(key)) continue;
    expect(after[key], `repair changed ${key}`).toEqual(baseline[key]);
  }
}

const damages: Record<string, Damage> = {
  "a parameter that no longer exists": { apply: (p) => (p.steps[0].transmuteMode = 0) },
  "an option value that has been retired": { apply: (p) => (p.steps[0].algorithm = -1) },
  "a number parameter holding a string": { apply: (p) => (p.steps[0].brushIntensity = "10"), affects: ["intensities"] },
  "a number parameter holding a boolean": { apply: (p) => (p.steps[0].brushIntensity = true), affects: ["intensities"] }, // prettier-ignore
  "a boolean parameter holding a number": { apply: (p) => (p.steps[0].accumulate = 1), affects: ["accumulate"] },
  "a string parameter holding a number": { apply: (p) => (p.steps[0].modulator1TexturePath = 5) },
  "a null in a kind with no null form": { apply: (p) => (p.steps[0].modulator1TexturePath = null) },
  "a file parameter holding a bare path": { apply: (p) => (p.steps[0].sourceFile = "/a/b.wav") },
  "a file parameter with an extra key": { apply: (p) => (p.steps[0].sourceFile = { path: "/a.wav", name: "a" }) },
  "a top-level field that has been removed": { apply: (p) => (p.retiredField = 1) },
  "no isFactory flag": { apply: (p) => delete p.isFactory },
  "no name": { apply: (p) => delete p.name, affects: ["name"] },
  "a version that is not a number": { apply: (p) => (p.version = "six") },
  "a version from the future": { apply: (p) => (p.version = 99) },
  "no version at all": { apply: (p) => delete p.version },
  "macro values of the wrong length": { apply: (p) => (p.macroValues = [50, 50]), affects: ["macroValues"] },
  "macro names of the wrong length": { apply: (p) => (p.macroNames = ["A"]), affects: ["macroNames"] },
  "a macro value holding a string": { apply: (p) => (p.macroValues = ["50", 20, 30, 40]), affects: ["macroValues"] },
  "a step with no id": { apply: (p) => delete p.steps[0].id },
  "a step with no name": { apply: (p) => delete p.steps[0].name, affects: ["stepNames"] },
  "a step colour that is not a colour": { apply: (p) => (p.steps[0].color = "blue") },
  "a brush colour that is not a colour": { apply: (p) => (p.color = "blue"), affects: ["color"] },
  "an effect item with no enabled flag": { apply: (p) => delete p.steps[0].effects[0].enabled },
  "an effect item whose params are a string": {
    apply: (p) => (p.steps[0].effects[0].params = "x"),
    affects: ["effectParams"],
  },
  "an effect item that is null": { apply: (p) => p.steps[0].effects.push(null) },
  "an effect that no longer exists": {
    apply: (p) => (p.steps[0].effects[0].effect = "overtones-of-yore"),
    affects: ["effects", "effectParams"],
  },
  "a retired option inside an effect's params": { apply: (p) => (p.steps[0].effects[0].params.algorithm = -1) },
  "a linked parameter that no longer exists": { apply: (p) => p.linkedParams.push("transmuteMode") },
  "a linked parameter that is not a string": { apply: (p) => p.linkedParams.push(5) },
  "a step key named __proto__": { apply: (p) => Object.assign(p.steps[0], JSON.parse('{"__proto__":1}')) },
  "a step key named constructor": { apply: (p) => (p.steps[0].constructor = 1) },
  "a top-level key named __proto__": { apply: (p) => Object.assign(p, JSON.parse('{"__proto__":1}')) },
  "a locked offset that is not an offset": { apply: (p) => (p.steps[0].lockedOffset = "here") },
  "a step that is not an object": { apply: (p) => (p.steps = [null]), affects: STEP_PARTS },
  "no steps at all": { apply: (p) => (p.steps = []), affects: STEP_PARTS },
};

describe("a preset written by an older build", () => {
  for (const [label, damage] of Object.entries(damages)) {
    it(`loads one carrying ${label}, losing only that`, () => {
      const preset = validPreset();
      damage.apply(preset);
      const result = validatePreset(preset);
      expect(result.success, result.success ? "" : result.errors.join("; ")).toBe(true);
      if (!result.success) return;

      expect(result.data.steps.length).toBeGreaterThan(0);
      expect(typeof result.data.id).toBe("string");
      expectOnlyAffected(result.data, validPreset(), damage.affects ?? []);
    });
  }

  it("refuses something that is not a preset at all", () => {
    const notPresets = ["not a preset", null, [1, 2], {}, { name: "Nearly" }, { ...validPreset(), steps: "one" }];
    for (const value of notPresets) {
      expect(validatePreset(value).success, `accepted ${JSON.stringify(value).slice(0, 40)}`).toBe(false);
    }
  });

  it("takes the id from the file it was read from when it has none", () => {
    const preset = validPreset();
    delete preset.id;
    const first = validatePreset(structuredClone(preset), "freq-stretch-123");
    const second = validatePreset(structuredClone(preset), "freq-stretch-123");
    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) {
      expect(first.data.id).toBe("freq-stretch-123");
      expect(second.data.id).toBe(first.data.id);
    }
  });

  it("keeps the effects the chain still has when one item is unusable", () => {
    const preset = validPreset();
    preset.steps[0].effects = [
      { id: "e1", effect: "transform", enabled: true, params: {} },
      { id: "e2", effect: "dynamics", enabled: 0, params: {} },
      null,
      { id: "e4", effect: "gone-for-good", enabled: true, params: {} },
    ];
    const result = validatePreset(preset);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const chain = result.data.steps[0].effects as { effect: string; enabled: boolean }[];
    expect(chain.map((e) => e.effect)).toEqual(["transform", "dynamics"]);
    expect(chain.map((e) => e.enabled)).toEqual([true, false]);
  });
});

/**
 * The store keeps runtime step fields no parameter owns. Sanitising a step must
 * leave them be, or persistence quietly strips them on every app start.
 */
describe("sanitising a step the store holds", () => {
  it("keeps the fields that belong to the step rather than to a parameter", () => {
    const step = {
      id: "s1",
      name: "Step 1",
      color: { hue: "blue", variation: 0 },
      lockedOffset: { beats: -0.25, pitch: -0.5 },
      effects: [{ id: "e1", effect: "transform", enabled: true, params: {} }],
    };
    expect(sanitizeStepParams(step)).toBe(step);
  });

  it("leaves a malformed effect chain for syncEffects to repair", () => {
    const step = { id: "s1", effects: [{ id: "e1", effect: "transform", enabled: 0 }] };
    expect(sanitizeStepParams(step)).toBe(step);
  });

  it("drops a key that resolves off the prototype instead of throwing", () => {
    const step = JSON.parse('{"id":"s1","name":"S","__proto__":1,"constructor":2}');
    const cleaned = sanitizeStepParams(step);
    expect(Object.hasOwn(cleaned, "__proto__")).toBe(false);
    expect(Object.hasOwn(cleaned, "constructor")).toBe(false);
    expect(cleaned.id).toBe("s1");
  });
});

describe("a preset that needs no repair", () => {
  it("comes back exactly as it went in", () => {
    const preset = validPreset();
    const result = validatePreset(structuredClone(preset));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(preset);
  });
});

function paletteAround(brushes: Record<string, any>[]): Record<string, any> {
  return { id: "pal1", name: "Kit", isFactory: false, version: CURRENT_PALETTE_VERSION, brushes };
}

function validPaletteBrush(): Record<string, any> {
  return { ...validBrush(), hotkey: null, libraryId: null };
}

describe("a palette written by an older build", () => {
  const brushDamages: Record<string, Damage> = {
    ...damages,
    "a brush field that has been removed": { apply: (b) => (b.retiredField = 1) },
    "a hotkey that is not a string": { apply: (b) => (b.hotkey = 7) },
    "a library id that is not a string": { apply: (b) => (b.libraryId = 7) },
    "no colour": { apply: (b) => delete b.color, affects: ["color"] },
    "a colour that is not a colour": { apply: (b) => (b.color = "blue"), affects: ["color"] },
  };

  for (const [label, damage] of Object.entries(brushDamages)) {
    it(`loads one whose brush carries ${label}, losing only that`, () => {
      const brush = validPaletteBrush();
      damage.apply(brush);
      const result = validatePalette(paletteAround([brush]));
      expect(result.success, result.success ? "" : result.errors.join("; ")).toBe(true);
      if (!result.success) return;
      expect(result.data.brushes).toHaveLength(1);
      expectOnlyAffected(result.data.brushes[0], validPaletteBrush(), damage.affects ?? []);
    });
  }

  it("loads one holding no brushes at all", () => {
    const empty = validatePalette(paletteAround([]));
    expect(empty.success).toBe(true);
    if (empty.success) expect(empty.data.brushes).toEqual([]);
  });

  it("drops a brush that is not an object, keeping the rest", () => {
    const result = validatePalette(paletteAround([null as any, validPaletteBrush()]));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.brushes.map((b) => b.name)).toEqual(["Test"]);
  });

  it("refuses a file that is not a palette", () => {
    for (const value of ["nope", null, [], {}, { name: "Nearly" }]) {
      expect(validatePalette(value).success, `accepted ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("takes the id from the file it was read from when it has none", () => {
    const palette = paletteAround([validPaletteBrush()]);
    delete palette.id;
    const first = validatePalette(structuredClone(palette), "test-123");
    const second = validatePalette(structuredClone(palette), "test-123");
    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) {
      expect(first.data.id).toBe("test-123");
      expect(second.data.id).toBe(first.data.id);
    }
  });

  it("gives two brushes that both lost their colour different ones", () => {
    const brushes = [validPaletteBrush(), validPaletteBrush()];
    brushes.forEach((brush) => delete brush.color);
    const result = validatePalette(paletteAround(brushes));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.brushes[0].color).not.toEqual(result.data.brushes[1].color);
  });

  it("comes back exactly as it went in when it needs no repair", () => {
    const palette = paletteAround([validPaletteBrush()]);
    const result = validatePalette(structuredClone(palette));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(palette);
  });
});
