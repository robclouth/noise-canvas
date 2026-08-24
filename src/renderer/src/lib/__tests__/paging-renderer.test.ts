import { WebGLRenderer } from "three";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createHarnessTextures, disposeHarnessTextures, toStrokeTextures } from "../../test/render-harness";
import { StrokeRenderer } from "../stroke-renderer";
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
  const built: { renderer: StrokeRenderer; textures: ReturnType<typeof createHarnessTextures> }[] = [];

  function makeRenderer(window: WindowLayout): StrokeRenderer {
    const textures = createHarnessTextures(data, window);
    const renderer = new StrokeRenderer(gl, data, toStrokeTextures(textures), "paging-test", {}, window);
    renderer.initialize();
    built.push({ renderer, textures });
    return renderer;
  }

  beforeAll(() => {
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
