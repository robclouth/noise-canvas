import { describe, expect, it } from "vitest";

import { bakeOnsetTexture, filterOnsets } from "../onset-map";

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

describe("bakeOnsetTexture", () => {
  it("maps every position to the nearest onset", () => {
    const texture = bakeOnsetTexture(
      [
        { timeSec: 0.2, strength: 1 },
        { timeSec: 0.8, strength: 0.5 },
      ],
      1,
    );
    const data = texture.image.data as Float32Array;
    const width = texture.image.width;
    const at = (t: number): { timeSec: number; present: number; strength: number } => {
      const x = Math.min(width - 1, Math.floor(t * width));
      return { timeSec: data[x * 4], present: data[x * 4 + 1], strength: data[x * 4 + 2] };
    };

    expect(at(0.05).timeSec).toBeCloseTo(0.2, 5);
    expect(at(0.45).timeSec).toBeCloseTo(0.2, 5);
    // Halfway between the two, the later one takes over.
    expect(at(0.55).timeSec).toBeCloseTo(0.8, 5);
    expect(at(0.95).timeSec).toBeCloseTo(0.8, 5);
    expect(at(0.95).present).toBe(1);
    expect(at(0.95).strength).toBeCloseTo(0.5, 5);
    texture.dispose();
  });

  it("bakes an empty map when there are no onsets", () => {
    const texture = bakeOnsetTexture([], 1);
    const data = texture.image.data as Float32Array;
    for (let x = 0; x < texture.image.width; x++) expect(data[x * 4 + 1]).toBe(0);
    texture.dispose();
  });
});
