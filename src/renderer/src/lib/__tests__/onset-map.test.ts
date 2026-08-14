import { describe, expect, it } from "vitest";

import { bakeOnsetTexture, filterOnsets, packOnsetState, spliceOnsets, unpackOnsetState } from "../onset-map";

// The addon reports every plausible peak with a raw salience and no threshold,
// so these cover the two things the renderer side is responsible for: turning
// a file's sensitivity into the set of onsets that count, and baking those into
// the nearest-onset row the shaders read.

function packed(pairs: [number, number][]): Float32Array {
  const out = new Float32Array(pairs.length * 2);
  pairs.forEach(([time, salience], i) => {
    out[i * 2] = time;
    out[i * 2 + 1] = salience;
  });
  return out;
}

describe("filterOnsets", () => {
  it("keeps a loop of equal hits at full strength whatever their absolute level", () => {
    const quiet = filterOnsets(packed([...Array(8)].map((_, i) => [i * 0.5, 0.3])), 50);
    const loud = filterOnsets(packed([...Array(8)].map((_, i) => [i * 0.5, 40])), 50);

    expect(quiet.length).toBe(8);
    expect(loud.length).toBe(8);
    for (const onset of [...quiet, ...loud]) expect(onset.strength).toBeCloseTo(1, 5);
  });

  it("ranks hits by level rather than by how isolated they are", () => {
    // Salience is an amplitude and the control spans the file's own range,
    // which here runs the 24 dB from the loudest hits down to the quietest. The
    // hit 12 dB down therefore sits at half strength, wherever it falls in the
    // bar and however many neighbours it has.
    const raw = packed([
      [0.1, 1],
      [0.2, 1],
      [0.3, 1],
      [0.4, 1],
      [0.5, 0.25],
      [0.6, 0.0625],
    ]);
    const found = filterOnsets(raw, 100);
    const strength = (t: number): number => found.find((o) => Math.abs(o.timeSec - t) < 1e-6)?.strength ?? -1;

    expect(strength(0.1)).toBeCloseTo(1, 5);
    expect(strength(0.5)).toBeCloseTo(0.5, 2);
    expect(strength(0.6)).toBeCloseTo(0, 5);
  });

  it("cuts hard at the threshold: an onset is either in or out", () => {
    const raw = packed([
      [0.1, 10],
      [0.2, 10],
      [0.3, 10],
      [0.4, 10],
      [0.5, 3],
      [0.6, 1],
    ]);

    // The 0.5 s hit sits halfway down the file's range: present in full just
    // above the matching sensitivity, absent just below it.
    const has = (sensitivity: number): boolean =>
      filterOnsets(raw, sensitivity).some((o) => Math.abs(o.timeSec - 0.5) < 1e-6);
    expect(has(60)).toBe(true);
    expect(has(40)).toBe(false);

    const kept = filterOnsets(raw, 60).find((o) => Math.abs(o.timeSec - 0.5) < 1e-6);
    expect(kept?.strength).toBeCloseTo(0.5, 1);
  });

  it("keeps only the loudest at zero sensitivity and everything at full", () => {
    const raw = packed([
      [0.1, 10],
      [0.2, 10],
      [0.3, 10],
      [0.4, 10],
      [0.5, 3],
      [0.6, 1],
    ]);

    expect(filterOnsets(raw, 100).length).toBe(6);
    const strictest = filterOnsets(raw, 0);
    expect(strictest.length).toBe(4);
    for (const onset of strictest) expect(onset.strength).toBeCloseTo(1, 5);
  });

  it("keeps the file's first event however quiet it is", () => {
    // A loop opening on a quiet hit: the same level later in the file is cut at
    // this sensitivity, but the one the file opens on is the anchor for the
    // head of the file and stays.
    const raw = packed([
      [0.0, 1],
      [0.1, 10],
      [0.2, 10],
      [0.3, 10],
      [0.4, 10],
      [0.5, 1],
    ]);
    const found = filterOnsets(raw, 50);
    const times = found.map((o) => o.timeSec);

    expect(times).toContain(0);
    expect(times).not.toContain(0.5);
    // Kept, but still drawn at its own level rather than promoted.
    expect(found[0].strength).toBeCloseTo(0, 5);
  });

  it("returns nothing without onsets", () => {
    expect(filterOnsets(undefined, 100)).toEqual([]);
    expect(filterOnsets(new Float32Array(0), 100)).toEqual([]);
  });
});

describe("spliceOnsets", () => {
  const existing = packed([
    [0.1, 1],
    [0.5, 2],
    [0.9, 3],
    [1.4, 4],
  ]);

  // Times come back as float32, so pairs are compared at that precision.
  const expectPairs = (out: Float32Array, pairs: [number, number][]): void => {
    expect(out.length).toBe(pairs.length * 2);
    pairs.forEach(([time, salience], i) => {
      expect(out[i * 2]).toBeCloseTo(time, 5);
      expect(out[i * 2 + 1]).toBeCloseTo(salience, 5);
    });
  };

  it("replaces only the span that was detected again", () => {
    const fresh = packed([
      [0.6, 9],
      [0.8, 8],
    ]);
    const out = spliceOnsets(existing, fresh, 0.4, 1.0);

    expectPairs(out, [
      [0.1, 1],
      [0.6, 9],
      [0.8, 8],
      [1.4, 4],
    ]);
  });

  it("drops the span's onsets when the repaint left nothing there", () => {
    const out = spliceOnsets(existing, new Float32Array(0), 0.4, 1.0);
    expectPairs(out, [
      [0.1, 1],
      [1.4, 4],
    ]);
  });

  it("is the whole list when there was nothing to splice into", () => {
    const fresh = packed([[0.6, 9]]);
    expectPairs(spliceOnsets(undefined, fresh, 0, 2), [[0.6, 9]]);
  });

  it("keeps a whole-file redetection equivalent to replacing outright", () => {
    const fresh = packed([
      [0.2, 5],
      [1.1, 6],
    ]);
    expect(Array.from(spliceOnsets(existing, fresh, 0, 2))).toEqual(Array.from(fresh));
  });
});

describe("packOnsetState", () => {
  it("round-trips the onsets and the reference they were found against", () => {
    const state = {
      onsets: packed([
        [0.25, 0.5],
        [1.5, 0.75],
      ]),
      reference: { odfMax: 12.5, bandMax: Float32Array.from([0.25, 0.5, 1]) },
    };
    const back = unpackOnsetState(packOnsetState(state));

    expect(Array.from(back!.onsets)).toEqual(Array.from(state.onsets));
    expect(back!.reference?.odfMax).toBeCloseTo(12.5, 5);
    expect(Array.from(back!.reference!.bandMax)).toEqual([0.25, 0.5, 1]);
  });

  it("round-trips onsets stored without a reference", () => {
    const onsets = packed([[0.25, 0.5]]);
    const back = unpackOnsetState(packOnsetState({ onsets }));

    expect(Array.from(back!.onsets)).toEqual([0.25, 0.5]);
    expect(back!.reference).toBeUndefined();
  });

  it("rejects a truncated record rather than reading past its end", () => {
    expect(unpackOnsetState(new Float32Array([1]))).toBeNull();
    expect(unpackOnsetState(Float32Array.from([1, 99, 0.5]))).toBeNull();
  });
});

describe("bakeOnsetTexture", () => {
  it("maps every position to its nearest, previous, and next onsets", () => {
    const texture = bakeOnsetTexture(
      [
        { timeSec: 0.2, strength: 1 },
        { timeSec: 0.8, strength: 0.5 },
      ],
      1,
    );
    const data = texture.image.data as Float32Array;
    const width = texture.image.width;
    const at = (t: number): { nearest: number; present: number; prev: number; next: number } => {
      const x = Math.min(width - 1, Math.floor(t * width));
      return { nearest: data[x * 4], present: data[x * 4 + 1], prev: data[x * 4 + 2], next: data[x * 4 + 3] };
    };

    expect(at(0.05).nearest).toBeCloseTo(0.2, 5);
    expect(at(0.05).prev).toBe(-1);
    expect(at(0.05).next).toBeCloseTo(0.2, 5);
    expect(at(0.45).nearest).toBeCloseTo(0.2, 5);
    expect(at(0.45).prev).toBeCloseTo(0.2, 5);
    expect(at(0.45).next).toBeCloseTo(0.8, 5);
    // Halfway between the two, the later one takes over as nearest.
    expect(at(0.55).nearest).toBeCloseTo(0.8, 5);
    expect(at(0.55).prev).toBeCloseTo(0.2, 5);
    expect(at(0.95).nearest).toBeCloseTo(0.8, 5);
    expect(at(0.95).prev).toBeCloseTo(0.8, 5);
    expect(at(0.95).next).toBe(-1);
    expect(at(0.95).present).toBe(1);
    texture.dispose();
  });

  it("bakes an empty map when there are no onsets", () => {
    const texture = bakeOnsetTexture([], 1);
    const data = texture.image.data as Float32Array;
    for (let x = 0; x < texture.image.width; x++) expect(data[x * 4 + 1]).toBe(0);
    texture.dispose();
  });
});
