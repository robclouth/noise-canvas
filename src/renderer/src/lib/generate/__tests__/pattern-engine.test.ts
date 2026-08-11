import { BEATS_PER_CYCLE, CUSTOM_CONTROLS, evaluatePattern, queryStamps } from "@renderer/lib/generate/pattern-engine";
import { GENERATE_PRESETS } from "@renderer/lib/generate/presets";
import { resolveBrushToken } from "@renderer/lib/generate/resolve-brush";
import type { Brush } from "@renderer/store/types";
import { describe, expect, it } from "vitest";

// Only the identity fields matter here; token resolution never reads steps or
// parameters, and building the store's real brush factory would pull the whole
// store graph into a pure test.
const makeBrush = (name: string): Brush => ({
  id: `brush-${name}`,
  name,
  color: { hue: "grape", variation: 0 },
  hotkey: null,
  steps: [],
  linkedParams: [],
  libraryId: null,
  macroNames: [],
  macroValues: [],
});

const stampsFor = (code: string, cycles = 1, seed = 0) => queryStamps(evaluatePattern(code), cycles, seed);

describe("evaluatePattern", () => {
  it("parses a bare mini-notation string", () => {
    const stamps = queryStamps(evaluatePattern('"a b c d"'), 1, 0);
    expect(stamps.map((stamp) => stamp.beats)).toEqual([0, 1, 2, 3]);
    expect(stamps.map((stamp) => stamp.durationBeats)).toEqual([1, 1, 1, 1]);
    expect(stamps.map((stamp) => stamp.brushToken)).toEqual(["a", "b", "c", "d"]);
  });

  it("accepts an expression returning a pattern", () => {
    const forward = stampsFor('"a b"').map((stamp) => stamp.brushToken);
    const reversed = stampsFor('mini("a b").rev()').map((stamp) => stamp.brushToken);
    expect(forward).toEqual(["a", "b"]);
    expect(reversed).toEqual(["b", "a"]);
  });

  it("reads the brush token and pitch offset from control values", () => {
    const stamps = stampsFor('s("a b").n("0 7")');
    expect(stamps.map((stamp) => stamp.brushToken)).toEqual(["a", "b"]);
    expect(stamps.map((stamp) => stamp.semis)).toEqual([0, 7]);
  });

  it("reads strength, pan, size and macros from controls", () => {
    const [first, second] = stampsFor('s("x*2").gain("1 0.25").pan("0 1").height("12 36").width("2 0.5")');
    expect(first.gain).toBe(1);
    expect(second.gain).toBe(0.25);
    // Strudel pans 0–1; the app's pan is centred on zero.
    expect(first.pan).toBe(-1);
    expect(second.pan).toBe(1);
    expect(first.heightSemis).toBe(12);
    expect(second.heightSemis).toBe(36);
    expect(first.widthBeats).toBe(2);
    expect(second.widthBeats).toBe(0.5);
  });

  it("reads macros only when the pattern sets them", () => {
    const [withMacros] = stampsFor('s("x").m1("0.2").m3("0.9")');
    expect(withMacros.macros).toEqual([0.2, undefined, 0.9, undefined]);
    expect(stampsFor('"x"')[0].macros).toBeUndefined();
  });

  it("reads absolute pitch from note names and numbers", () => {
    const named = stampsFor('s("x*2").note("c4 a4")');
    expect(named[0].noteMidi).toBe(60);
    expect(named[1].noteMidi).toBe(69);
    expect(stampsFor('s("x").note("60")')[0].noteMidi).toBe(60);
    expect(stampsFor('"x"')[0].noteMidi).toBeUndefined();
  });

  it("registers every custom control as a pattern method", () => {
    for (const control of CUSTOM_CONTROLS) {
      expect(() => evaluatePattern(`s("x").${control}("1")`), `${control} is not callable`).not.toThrow();
      expect(() => evaluatePattern(`${control}("1")`), `${control} is missing from the scope`).not.toThrow();
    }
  });

  it("rejects empty and non-pattern code", () => {
    expect(() => evaluatePattern("   ")).toThrow(/Empty pattern/);
    expect(() => evaluatePattern("42")).toThrow(/Pattern expected/);
    expect(() => evaluatePattern("mini(")).toThrow();
  });
});

describe("queryStamps", () => {
  it("splits subdivided groups into shorter stamps", () => {
    const stamps = stampsFor('"a [b b]"');
    expect(stamps.map((stamp) => stamp.durationBeats)).toEqual([2, 1, 1]);
    expect(stamps.map((stamp) => stamp.beats)).toEqual([0, 2, 3]);
  });

  it("drops rests", () => {
    const stamps = stampsFor('"a ~ b ~"');
    expect(stamps.map((stamp) => stamp.beats)).toEqual([0, 2]);
  });

  it("expands euclidean rhythms", () => {
    const stamps = stampsFor('"x(3,8)"');
    expect(stamps).toHaveLength(3);
    expect(stamps.map((stamp) => stamp.beats)).toEqual([0, 1.5, 3]);
  });

  it("advances alternations across cycles", () => {
    const stamps = stampsFor('"<a b>"', 2);
    expect(stamps.map((stamp) => stamp.brushToken)).toEqual(["a", "b"]);
    expect(stamps.map((stamp) => stamp.beats)).toEqual([0, BEATS_PER_CYCLE]);
  });

  it("covers every requested cycle", () => {
    const stamps = stampsFor('"x*2"', 3);
    expect(stamps).toHaveLength(6);
    expect(stamps[stamps.length - 1].beats).toBe(10);
  });

  it("is deterministic for a seed and varies between seeds", () => {
    const beatsAt = (seed: number) => stampsFor('"x*16?"', 4, seed).map((stamp) => stamp.beats);
    expect(beatsAt(3)).toEqual(beatsAt(3));
    const seeds = [0, 1, 2, 3, 4, 5].map((seed) => beatsAt(seed).join(","));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("keeps stamps sorted by onset", () => {
    const stamps = stampsFor('stack("x*3", "y*5")', 2);
    const beats = stamps.map((stamp) => stamp.beats);
    expect([...beats].sort((a, b) => a - b)).toEqual(beats);
  });

  it("rejects patterns denser than the stamp limit", () => {
    expect(() => stampsFor('"x*512"', 4)).toThrow(/too dense/);
  });
});

describe("GENERATE_PRESETS", () => {
  it("all evaluate and produce stamps", () => {
    for (const preset of GENERATE_PRESETS) {
      const stamps = queryStamps(evaluatePattern(preset.code), 4, 0);
      expect(stamps.length, `${preset.name} produced no stamps`).toBeGreaterThan(0);
      for (const stamp of stamps) {
        expect(stamp.durationBeats).toBeGreaterThan(0);
        expect(Number.isFinite(stamp.beats)).toBe(true);
      }
    }
  });
});

describe("resolveBrushToken", () => {
  const brushes: Brush[] = [makeBrush("Sweep"), makeBrush("Grain"), makeBrush("Blur")];
  brushes[1].hotkey = "g";

  it("maps digits to slots with 0 as the tenth", () => {
    expect(resolveBrushToken("1", brushes)).toBe(0);
    expect(resolveBrushToken("3", brushes)).toBe(2);
    expect(resolveBrushToken("4", brushes)).toBe(null);
    expect(resolveBrushToken("0", brushes)).toBe(null);
    expect(
      resolveBrushToken(
        "0",
        Array.from({ length: 10 }, (_, i) => makeBrush(`B${i}`)),
      ),
    ).toBe(9);
  });

  it("maps a letter to its hotkey", () => {
    expect(resolveBrushToken("g", brushes)).toBe(1);
    expect(resolveBrushToken("G", brushes)).toBe(1);
  });

  it("maps a word to a brush name, case-insensitively", () => {
    expect(resolveBrushToken("blur", brushes)).toBe(2);
    expect(resolveBrushToken("Sweep", brushes)).toBe(0);
  });

  it("returns null for unknown tokens so the active brush is used", () => {
    expect(resolveBrushToken("x", brushes)).toBe(null);
    expect(resolveBrushToken("", brushes)).toBe(null);
  });
});
