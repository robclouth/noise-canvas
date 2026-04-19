import { describe, expect, it } from "vitest";
import {
  buildScaleOffsets,
  minFreqSemisAboveC0,
  snapSemisToScale,
  stepScaleSemis,
  tonicSemitoneClass,
} from "../scale-snap";

describe("scale-snap", () => {
  describe("buildScaleOffsets", () => {
    it("returns all zeros for an invalid scale type", () => {
      const offsets = buildScaleOffsets("C", "not-a-scale");
      for (let i = 0; i < 12; i++) expect(offsets[i]).toBe(0);
    });

    it("C major: zeros on scale tones, prefers-up on non-scale tones", () => {
      const offsets = buildScaleOffsets("C", "major");
      // C major pitch classes: C(0) D(2) E(4) F(5) G(7) A(9) B(11)
      expect(offsets[0]).toBe(0); // C
      expect(offsets[2]).toBe(0); // D
      expect(offsets[4]).toBe(0); // E
      expect(offsets[5]).toBe(0); // F
      expect(offsets[7]).toBe(0); // G
      expect(offsets[9]).toBe(0); // A
      expect(offsets[11]).toBe(0); // B
      // Non-scale: C# up to D (+1); D# up to E (+1); F# up to G (+1); G# up to A (+1); A# up to B (+1)
      expect(offsets[1]).toBe(1);
      expect(offsets[3]).toBe(1);
      expect(offsets[6]).toBe(1);
      expect(offsets[8]).toBe(1);
      expect(offsets[10]).toBe(1);
    });

    it("D major absolute chroma: D(2) E(4) F#(6) G(7) A(9) B(11) C#(1)", () => {
      const offsets = buildScaleOffsets("D", "major");
      expect(offsets[2]).toBe(0);
      expect(offsets[4]).toBe(0);
      expect(offsets[6]).toBe(0);
      expect(offsets[7]).toBe(0);
      expect(offsets[9]).toBe(0);
      expect(offsets[11]).toBe(0);
      expect(offsets[1]).toBe(0);
      // Non-scale pcs
      expect(offsets[0]).toBe(1); // C up to C# (in D major)
      expect(offsets[3]).toBe(1); // D# up to E
      expect(offsets[5]).toBe(1); // F up to F#
      expect(offsets[8]).toBe(1); // G# up to A
      expect(offsets[10]).toBe(1); // A# up to B
    });
  });

  describe("snapSemisToScale", () => {
    const offsets = buildScaleOffsets("C", "major");

    it("on-scale values unchanged", () => {
      expect(snapSemisToScale(0, offsets)).toBe(0); // C
      expect(snapSemisToScale(4, offsets)).toBe(4); // E
      expect(snapSemisToScale(12, offsets)).toBe(12); // C next octave
    });

    it("near-boundary values pick truly-nearest scale note", () => {
      // 2.9 is closer to D (2) than to E (4)
      expect(snapSemisToScale(2.9, offsets)).toBe(2);
      // 3.1 is closer to E (4) than to D (2)
      expect(snapSemisToScale(3.1, offsets)).toBe(4);
      // 3.5 equidistant — pick upper (E) because low-side candidate is 4 vs high-side 4
      expect(snapSemisToScale(3.5, offsets)).toBe(4);
    });

    it("negative values work across octave boundaries", () => {
      // -1 (B below C0) → nearest in-scale: B at -1? pc=11, bits[11]=1 → stays at -1
      expect(snapSemisToScale(-1, offsets)).toBe(-1);
      // -0.4 → chromaLow=-1 (B), candLow=-1; chromaHigh=0 (C), candHigh=0; dist 0.6 vs 0.4 → 0 (C)
      expect(snapSemisToScale(-0.4, offsets)).toBe(0);
    });

    it("D major: brush at C (target 0) snaps to C# (+1)", () => {
      const d = buildScaleOffsets("D", "major");
      // C is pc 0, offset=+1 to C#. At exactly 0, candLow=1, candHigh=1 (chromaHigh=1, offsets[1]=0). Pick 1.
      expect(snapSemisToScale(0, d)).toBe(1);
    });
  });

  describe("stepScaleSemis", () => {
    const offsets = buildScaleOffsets("C", "major");

    it("stepping up from C lands on D", () => {
      expect(stepScaleSemis(0, 1, offsets)).toBe(2);
    });

    it("stepping up from E lands on F (half-step in scale)", () => {
      expect(stepScaleSemis(4, 1, offsets)).toBe(5);
    });

    it("stepping down from C lands on B below", () => {
      expect(stepScaleSemis(0, -1, offsets)).toBe(-1);
    });

    it("from a non-scale target snaps first, then steps", () => {
      // target 0.4 snaps to 0 (C), step up → D (2)
      expect(stepScaleSemis(0.4, 1, offsets)).toBe(2);
      // target 1.6 snaps to 2 (D), step up → E (4)
      expect(stepScaleSemis(1.6, 1, offsets)).toBe(4);
    });
  });

  describe("tonicSemitoneClass", () => {
    it("maps common tonics", () => {
      expect(tonicSemitoneClass("C")).toBe(0);
      expect(tonicSemitoneClass("D")).toBe(2);
      expect(tonicSemitoneClass("F#")).toBe(6);
      expect(tonicSemitoneClass("B")).toBe(11);
    });
  });

  describe("minFreqSemisAboveC0", () => {
    it("C0 itself returns 0", () => {
      expect(minFreqSemisAboveC0(16.3516)).toBeCloseTo(0, 3);
    });

    it("A4 (440 Hz) ≈ 57 semitones above C0", () => {
      expect(minFreqSemisAboveC0(440)).toBeCloseTo(57, 2);
    });
  });

  describe("shader-critical scenario: transform shift snap", () => {
    it("brush at C with +3 st shift in C major snaps to E (+4)", () => {
      // This mirrors the shader path: target = brushBasePitchAbsSemis + shiftSemis
      const offsets = buildScaleOffsets("C", "major");
      const brushAbsSemis = 60; // C4
      const shiftSemis = 3;
      const target = brushAbsSemis + shiftSemis; // 63 = D#4
      const snapped = snapSemisToScale(target, offsets); // → 64 (E4)
      const appliedShift = snapped - brushAbsSemis;
      expect(appliedShift).toBe(4);
    });
  });
});
