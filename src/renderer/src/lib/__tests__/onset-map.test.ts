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

  it("drops weak detections before strong ones as sensitivity falls", () => {
    const raw = packed([
      [0.1, 10],
      [0.2, 0.6],
      [0.3, 10],
      [0.4, 0.3],
      [0.5, 10],
    ]);

    expect(filterOnsets(raw, 100).length).toBe(5);
    const middling = filterOnsets(raw, 50);
    expect(middling.length).toBe(3);
    middling.forEach((onset, i) => expect(onset.timeSec).toBeCloseTo(0.1 + i * 0.2, 5));
    for (const onset of middling) expect(onset.strength).toBeCloseTo(1, 5);
  });

  it("re-anchors a surviving onset in full however quiet it is", () => {
    // What the shaders read is the weight, and it says whether the moment
    // counts as an attack — a ghost note that clears the control earns the same
    // treatment as the loudest hit in the bar, while what is drawn still shows
    // which of them is which.
    const raw = packed([
      [0.1, 10],
      [0.2, 10],
      [0.3, 10],
      [0.4, 3],
      [0.5, 1],
    ]);
    const found = filterOnsets(raw, 100);
    const quiet = found.find((o) => Math.abs(o.timeSec - 0.4) < 1e-6);

    expect(quiet).toBeDefined();
    expect(quiet?.weight).toBeCloseTo(1, 5);
    expect(quiet?.strength).toBeLessThan(0.6);
  });

  it("fades an onset out rather than dropping it in one step", () => {
    const raw = packed([
      [0.1, 10],
      [0.2, 10],
      [0.3, 10],
      [0.4, 10],
      [0.5, 3],
      [0.6, 1],
    ]);

    // The 0.5 s hit sits halfway down the file's range, so it fades across the
    // knee the threshold passes through as sensitivity drops.
    const weights = [58, 50, 40].map((sensitivity) => {
      const found = filterOnsets(raw, sensitivity).find((o) => Math.abs(o.timeSec - 0.5) < 1e-6);
      return found?.weight ?? 0;
    });

    expect(weights[0]).toBeGreaterThan(weights[1]);
    expect(weights[1]).toBeGreaterThan(weights[2]);
    expect(weights[2]).toBe(0);
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
        { timeSec: 0.2, weight: 1, strength: 1 },
        { timeSec: 0.8, weight: 1, strength: 0.5 },
      ],
      1,
    );
    const data = texture.image.data as Float32Array;
    const width = texture.image.width;
    const at = (t: number): { timeSec: number; weight: number; strength: number } => {
      const x = Math.min(width - 1, Math.floor(t * width));
      return { timeSec: data[x * 4], weight: data[x * 4 + 1], strength: data[x * 4 + 2] };
    };

    expect(at(0.05).timeSec).toBeCloseTo(0.2, 5);
    expect(at(0.45).timeSec).toBeCloseTo(0.2, 5);
    // Halfway between the two, the later one takes over.
    expect(at(0.55).timeSec).toBeCloseTo(0.8, 5);
    expect(at(0.95).timeSec).toBeCloseTo(0.8, 5);
    expect(at(0.95).weight).toBeCloseTo(1, 5);
    expect(at(0.95).strength).toBeCloseTo(0.5, 5);
    texture.dispose();
  });

  it("bakes a weight of zero everywhere when there are no onsets", () => {
    const texture = bakeOnsetTexture([], 1);
    const data = texture.image.data as Float32Array;
    for (let x = 0; x < texture.image.width; x++) expect(data[x * 4 + 1]).toBe(0);
    texture.dispose();
  });
});
