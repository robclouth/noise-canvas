import { Vector2, WebGLRenderer } from "three";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { State } from "../../store/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockStateWithSteps } from "../../test/mock-state";
import {
  createHarnessTextures,
  createSourceFile,
  disposeHarnessTextures,
  makeStrokeParams,
  toStrokeTextures,
} from "../../test/render-harness";
import { StrokeRenderer, type EffectsRegistry } from "../stroke-renderer";
import { BRUSH_SIZE_PITCH_FULL } from "../utils";
import { buildWindowLayout, fileLayoutOf, windowFileRanges, type WindowLayout } from "../window-layout";

/**
 * Stage 2's boundary: the renderer's public methods trade in file packed
 * indices whatever it actually holds. A window must answer a read, a patch and
 * a phase turn exactly as the whole file does for the pixels it holds, and must
 * drop — never substitute — the pixels it does not.
 */

const SAMPLE_RATE = 8000;

describe("paged renderer boundary", () => {
  const data = createConstantQMockSpectrogramData({
    durationSeconds: 2,
    sampleRate: SAMPLE_RATE,
    bandsPerOctave: 4,
  });
  const layout = fileLayoutOf(data);

  // Distinct values per packed pixel, so a mis-mapped range cannot pass.
  for (let b = 0; b < layout.numBands; b++) {
    for (let k = 0; k < layout.bandLengths[b]; k++) {
      const pixel = (layout.bandOffsets[b] + k) * 4;
      data.packedData[pixel + 0] = b * 4096 + k + 1;
      data.packedData[pixel + 1] = (b * 4096 + k + 1) * 0.001;
      data.packedData[pixel + 2] = b * 4096 + k + 2;
      data.packedData[pixel + 3] = (b * 4096 + k + 2) * 0.001;
    }
  }

  const wholeFile = buildWindowLayout(layout, 0, layout.numFrames);
  const half = buildWindowLayout(layout, Math.floor(layout.numFrames / 4), Math.floor((layout.numFrames * 3) / 4));

  let gl: WebGLRenderer;
  let effects: EffectsRegistry;
  const built: { renderer: StrokeRenderer; textures: ReturnType<typeof createHarnessTextures> }[] = [];

  function makeRenderer(window: WindowLayout): StrokeRenderer {
    const textures = createHarnessTextures(data, window);
    const renderer = new StrokeRenderer(gl, data, toStrokeTextures(textures), "paging-test", effects, window);
    renderer.initialize();
    built.push({ renderer, textures });
    return renderer;
  }

  beforeAll(async () => {
    effects = (await import("../../effects")).effects as EffectsRegistry;
    gl = new WebGLRenderer({ antialias: false });
  });

  afterAll(() => {
    for (const { renderer, textures } of built) {
      renderer.dispose();
      disposeHarnessTextures(textures);
    }
    gl.dispose();
  });

  /** File ranges every band holds inside the window, shortened so both edges are interior. */
  function interiorRanges(): Uint32Array {
    const ranges: number[] = [];
    for (let b = 0; b < half.numBands; b++) {
      const length = half.bandLengths[b];
      if (length < 4) continue;
      const trim = Math.max(1, Math.floor(length / 8));
      ranges.push(layout.bandOffsets[b] + half.firstBins[b] + trim, length - 2 * trim);
    }
    return Uint32Array.from(ranges);
  }

  it("reads the window's pixels exactly as the whole file reads them", async () => {
    const whole = makeRenderer(wholeFile);
    const paged = makeRenderer(half);
    const ranges = windowFileRanges(half);

    const baseline = await whole.readPixelRanges(ranges);
    const windowed = await paged.readPixelRanges(ranges);

    expect(windowed.length).toBe(baseline.length);
    expect(Array.from(windowed)).toEqual(Array.from(baseline));
  });

  it("patches by file index and reads the patch back", async () => {
    const whole = makeRenderer(wholeFile);
    const paged = makeRenderer(half);
    const ranges = interiorRanges();

    const patched = Float32Array.from(data.packedData);
    for (let i = 0; i < ranges.length; i += 2) {
      for (let p = ranges[i]; p < ranges[i] + ranges[i + 1]; p++) {
        patched[p * 4] = -patched[p * 4];
        patched[p * 4 + 2] = -patched[p * 4 + 2];
      }
    }

    whole.patchFBOData(patched, ranges);
    paged.patchFBOData(patched, ranges);

    const baseline = await whole.readPixelRanges(ranges);
    const windowed = await paged.readPixelRanges(ranges);
    expect(Array.from(windowed)).toEqual(Array.from(baseline));

    // And the patch actually landed, so the comparison is not of two no-ops.
    expect(windowed[0]).toBeLessThan(0);
  });

  it("turns phase by file index the way the whole file does", async () => {
    const whole = makeRenderer(wholeFile);
    const paged = makeRenderer(half);
    const ranges = interiorRanges();

    const turns: number[] = [];
    for (let i = 0; i < ranges.length; i += 2) turns.push(ranges[i], ranges[i + 1], 2, -3);

    whole.applyPhaseTurns(turns);
    paged.applyPhaseTurns(turns);

    const baseline = await whole.readPixelRanges(ranges);
    const windowed = await paged.readPixelRanges(ranges);
    expect(Array.from(windowed)).toEqual(Array.from(baseline));
    expect(windowed[1]).toBeCloseTo(baseline[1], 5);
  });

  it("takes a whole-file array through setFBOData and reads back what the whole file does", async () => {
    const whole = makeRenderer(wholeFile);
    const paged = makeRenderer(half);
    const ranges = windowFileRanges(half);

    const altered = Float32Array.from(data.packedData);
    for (let i = 0; i < altered.length; i += 4) {
      altered[i] += 0.5;
      altered[i + 2] += 0.25;
    }

    whole.setFBOData(altered);
    paged.setFBOData(altered);

    const baseline = await whole.readPixelRanges(ranges);
    const windowed = await paged.readPixelRanges(ranges);
    expect(Array.from(windowed)).toEqual(Array.from(baseline));
    // And the upload landed, so the comparison is not of two untouched canvases.
    expect(windowed[0]).toBe(data.packedData[ranges[0] * 4] + 0.5);
  });

  it("paints a committed stroke identically under a window", async () => {
    const whole = makeRenderer(wholeFile);
    const paged = makeRenderer(half);
    const ranges = interiorRanges();

    const state = createMockStateWithSteps([
      {
        name: "Gain",
        overrides: {
          brushIntensity: 100,
          brushSizeTime: 1,
          brushSizePitch: BRUSH_SIZE_PITCH_FULL,
          effects: [{ id: "paging-dyn", effect: "dynamics" as const, enabled: true, params: { dynamicsGainDb: -18 } }],
        },
      },
    ]) as State;

    // Two overlapping dabs well inside the window, so the stroke mask's
    // running max is on the path under test too.
    for (const renderer of [whole, paged]) {
      const source = createSourceFile(renderer, data);
      renderer.beginStroke();
      renderer.renderStroke(makeStrokeParams(new Vector2(0.4, 0.0), data), state, source);
      renderer.renderStroke(makeStrokeParams(new Vector2(0.45, 0.0), data), state, source);
    }

    const baseline = await whole.readPixelRanges(ranges);
    const windowed = await paged.readPixelRanges(ranges);
    expect(Array.from(windowed)).toEqual(Array.from(baseline));

    // And the stroke changed something, so equality is not of two no-ops.
    let changed = 0;
    let cursor = 0;
    for (let i = 0; i < ranges.length; i += 2) {
      for (let p = 0; p < ranges[i + 1]; p++) {
        if (baseline[(cursor + p) * 4] !== data.packedData[(ranges[i] + p) * 4]) changed++;
      }
      cursor += ranges[i + 1];
    }
    expect(changed).toBeGreaterThan(100);
  });

  it("drops the pixels it does not hold instead of substituting the window's edge", async () => {
    const paged = makeRenderer(half);
    // One band's whole file span: the window holds its middle and nothing else.
    const band = Math.floor(layout.numBands / 2);
    const ranges = Uint32Array.of(layout.bandOffsets[band], layout.bandLengths[band]);

    const read = await paged.readPixelRanges(ranges);
    expect(read.length).toBe(layout.bandLengths[band] * 4);

    const first = half.firstBins[band];
    const last = first + half.bandLengths[band];
    let resident = 0;
    let missing = 0;
    for (let k = 0; k < layout.bandLengths[band]; k++) {
      const expected = data.packedData[(layout.bandOffsets[band] + k) * 4];
      if (k >= first && k < last) {
        resident++;
        expect(read[k * 4]).toBe(expected);
      } else {
        missing++;
        expect(read[k * 4]).toBe(0);
      }
    }
    expect(resident).toBeGreaterThan(0);
    expect(missing).toBeGreaterThan(0);
  });
});
