import { describe, expect, it } from "vitest";

import { bakeOnsetTexture, filterOnsets } from "../onset-map";

// The addon reports every plausible peak with a raw salience and no threshold,
// so these cover the two things the renderer side is responsible for: turning
// the sensitivity control into a set of onsets, and baking those into the
// nearest-onset row the shaders read.

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

  it("drops weak detections before strong ones as sensitivity falls", () => {
    const raw = packed([
      [0.1, 10],
      [0.2, 2],
      [0.3, 10],
      [0.4, 1],
      [0.5, 10],
    ]);

    expect(filterOnsets(raw, 100).length).toBe(5);
    const middling = filterOnsets(raw, 50);
    expect(middling.length).toBe(3);
    middling.forEach((onset, i) => expect(onset.timeSec).toBeCloseTo(0.1 + i * 0.2, 5));
    for (const onset of middling) expect(onset.strength).toBeCloseTo(1, 5);
  });

  it("fades an onset out rather than dropping it in one step", () => {
    const raw = packed([
      [0.1, 10],
      [0.2, 10],
      [0.3, 10],
      [0.4, 5],
    ]);

    // The 0.4 s hit sits at half the reference level, so it fades across the
    // knee the threshold passes through as sensitivity drops.
    const strengths = [58, 50, 40].map((sensitivity) => {
      const found = filterOnsets(raw, sensitivity).find((o) => Math.abs(o.timeSec - 0.4) < 1e-6);
      return found?.strength ?? 0;
    });

    expect(strengths[0]).toBeGreaterThan(strengths[1]);
    expect(strengths[1]).toBeGreaterThan(strengths[2]);
    expect(strengths[2]).toBe(0);
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
    const at = (t: number): { timeSec: number; strength: number } => {
      const x = Math.min(width - 1, Math.floor(t * width));
      return { timeSec: data[x * 4], strength: data[x * 4 + 1] };
    };

    expect(at(0.05).timeSec).toBeCloseTo(0.2, 5);
    expect(at(0.45).timeSec).toBeCloseTo(0.2, 5);
    // Halfway between the two, the later one takes over.
    expect(at(0.55).timeSec).toBeCloseTo(0.8, 5);
    expect(at(0.95).timeSec).toBeCloseTo(0.8, 5);
    expect(at(0.95).strength).toBeCloseTo(0.5, 5);
    texture.dispose();
  });

  it("bakes a strength of zero everywhere when there are no onsets", () => {
    const texture = bakeOnsetTexture([], 1);
    const data = texture.image.data as Float32Array;
    for (let x = 0; x < texture.image.width; x++) expect(data[x * 4 + 1]).toBe(0);
    texture.dispose();
  });
});
