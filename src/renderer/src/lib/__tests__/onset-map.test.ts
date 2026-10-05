import {
  DataTexture,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  WebGLRenderTarget,
} from "three";
import { describe, expect, it } from "vitest";
import { createDefaultUniforms } from "../../effects/base-effect";
import passThroughVert from "../../glsl/pass-through.vert";
import probeFrag from "../../test/onset-probe.frag";
import { createGL } from "../../test/render-harness";

import {
  bakeOnsetTexture,
  filterOnsets,
  packOnsetState,
  spliceOnsets,
  unpackOnsetState,
  type Onset,
} from "../onset-map";

// The addon reports every plausible peak with a raw salience and no threshold,
// so these cover the two things the renderer side is responsible for: turning
// a file's sensitivity into the set of onsets that count, and baking those into
// the texture the shaders search.

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

/** What sourceOnsetsAround returns at each of `times`, read back from the GPU. */
function onsetsAround(onsets: Onset[], durationSec: number, times: number[]): Float32Array {
  const gl = createGL();
  const onsetTexture = bakeOnsetTexture(onsets, durationSec);
  const probeTex = new DataTexture(
    new Float32Array(times.flatMap((t) => [t, 0, 0, 0])),
    times.length,
    1,
    RGBAFormat,
    FloatType,
  );
  probeTex.needsUpdate = true;
  const material = new RawShaderMaterial({
    uniforms: { ...createDefaultUniforms(), sourceOnsetTex: { value: onsetTexture }, probeTex: { value: probeTex } },
    vertexShader: passThroughVert,
    fragmentShader: probeFrag,
    glslVersion: GLSL3,
  });
  const target = new WebGLRenderTarget(times.length, 1, {
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });
  const scene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), material));
  gl.setRenderTarget(target);
  gl.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  const out = new Float32Array(times.length * 4);
  gl.readRenderTargetPixels(target, 0, 0, times.length, 1, out);
  gl.setRenderTarget(null);
  target.dispose();
  material.dispose();
  probeTex.dispose();
  onsetTexture.dispose();
  gl.dispose();
  return out;
}

describe("bakeOnsetTexture", () => {
  it("maps every position to its nearest, previous, and next onsets", () => {
    const out = onsetsAround(
      [
        { timeSec: 0.2, strength: 1 },
        { timeSec: 0.8, strength: 0.5 },
      ],
      1,
      [0.05, 0.45, 0.55, 0.95],
    );
    const at = (i: number) => ({
      nearest: out[i * 4],
      present: out[i * 4 + 1],
      prev: out[i * 4 + 2],
      next: out[i * 4 + 3],
    });

    expect(at(0).nearest).toBeCloseTo(0.2, 5);
    expect(at(0).prev).toBe(-1);
    expect(at(0).next).toBeCloseTo(0.2, 5);
    expect(at(1).nearest).toBeCloseTo(0.2, 5);
    expect(at(1).prev).toBeCloseTo(0.2, 5);
    expect(at(1).next).toBeCloseTo(0.8, 5);
    // Past halfway between the two, the later one takes over as nearest.
    expect(at(2).nearest).toBeCloseTo(0.8, 5);
    expect(at(2).prev).toBeCloseTo(0.2, 5);
    expect(at(3).nearest).toBeCloseTo(0.8, 5);
    expect(at(3).prev).toBeCloseTo(0.8, 5);
    expect(at(3).next).toBe(-1);
    expect(at(3).present).toBe(1);
  });

  it("reads no onsets when there are none", () => {
    const out = onsetsAround([], 1, [0.1, 0.9]);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("finds the neighbours as exactly twenty minutes in as at the start", () => {
    const durationSec = 1200;
    // Onsets clustered and spread unevenly, some a few milliseconds apart.
    const onsets: Onset[] = [];
    for (let k = 0; k < 3000; k++) {
      const t = Math.fround((durationSec * (k + 0.5 * Math.sin(k * 1.7) ** 2)) / 3000);
      onsets.push({ timeSec: t, strength: 1 });
      if (k % 7 === 0) onsets.push({ timeSec: Math.fround(t + 0.004), strength: 1 });
    }
    onsets.sort((a, b) => a.timeSec - b.timeSec);
    const times: number[] = [];
    for (const { timeSec } of onsets.slice(0, 40).concat(onsets.slice(-40))) {
      times.push(Math.fround(timeSec - 0.001), timeSec, Math.fround(timeSec + 0.001));
    }
    const out = onsetsAround(onsets, durationSec, times);
    const misses: string[] = [];
    times.forEach((t, i) => {
      let next = 0;
      while (next < onsets.length && onsets[next].timeSec <= t) next++;
      const prev = next > 0 ? onsets[next - 1].timeSec : -1;
      const after = next < onsets.length ? onsets[next].timeSec : -1;
      if (out[i * 4 + 2] !== prev || out[i * 4 + 3] !== after) {
        misses.push(`${t}: ${out[i * 4 + 2]}, ${out[i * 4 + 3]}, not ${prev}, ${after}`);
      }
    });
    expect(misses.slice(0, 8), `${misses.length} of ${times.length} times`).toEqual([]);
  });
});
