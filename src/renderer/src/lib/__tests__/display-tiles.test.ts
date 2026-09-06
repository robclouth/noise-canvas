import { describe, expect, it } from "vitest";

import type { BandLayout } from "../band-layout";
import {
  DISPLAY_TILES_BYTES_PER_TEXEL,
  DISPLAY_TILES_MAX_TEXELS,
  displayTilesBytes,
  ringLevelChoice,
  ringSlotCount,
  ringWindow,
  tileFramesFor,
  tileGrid,
} from "../display-tiles";
import { constantQBandLayout, constantQMetadata } from "../../test/mock-spectrogram";

const SAMPLE_RATE = 48000;
const VIEWPORT = 1500;

/** A constant-Q band layout of the given length, without the packed data. */
function layoutOf(durationSeconds: number, bandsPerOctave = 36): BandLayout & { numFrames: number } {
  const bands = constantQBandLayout({ durationSeconds, sampleRate: SAMPLE_RATE, bandsPerOctave });
  return {
    numBands: bands.numBands,
    metadata: constantQMetadata(bands, { bandsPerOctave }),
    numFrames: bands.numFrames,
  };
}

/** Bands laid out by hand, so a test can name every step. */
function handLayout(steps: number[], lengths: number[]): BandLayout {
  const metadata = new Float64Array(steps.length * 4);
  let offset = 0;
  for (let band = 0; band < steps.length; band++) {
    metadata[band * 4] = offset;
    metadata[band * 4 + 1] = lengths[band];
    metadata[band * 4 + 2] = steps[band];
    metadata[band * 4 + 3] = 1000 - band;
    offset += lengths[band];
  }
  return { numBands: steps.length, metadata };
}

describe("tileFramesFor", () => {
  it("holds a whole number of every band's bins", () => {
    const layout = layoutOf(120);
    for (let level = 0; level <= 16; level++) {
      const frames = tileFramesFor(layout, level);
      for (let band = 0; band < layout.numBands; band++) {
        const step = 2 ** Math.max(layout.metadata[band * 4 + 2], level);
        expect(frames % step, `level ${level}, band ${band}`).toBe(0);
      }
    }
  });

  it("widens with the level once the band grid stops forcing it", () => {
    const layout = handLayout([0, 1], [64, 32]);
    // The coarsest band steps 2 frames, so a tile is 256 screen pixels wide
    // from level 0 up, and doubles with the level after that.
    expect(tileFramesFor(layout, 0)).toBe(256);
    expect(tileFramesFor(layout, 1)).toBe(512);
    expect(tileFramesFor(layout, 4)).toBe(4096);
  });

  it("never falls below the coarsest band's step", () => {
    const layout = handLayout([0, 20], [1 << 20, 1]);
    expect(tileFramesFor(layout, 0)).toBe(2 ** 20);
  });
});

describe("tileGrid", () => {
  const layout = layoutOf(120);

  it("gives every band a bin count that divides the tile exactly", () => {
    for (const level of [0, 3, 7, 11]) {
      const grid = tileGrid(layout, layout.numFrames, level);
      for (let band = 0; band < layout.numBands; band++) {
        const ringStep = grid.metadata[band * 4 + 2];
        const binsPerTile = grid.metadata[band * 4 + 3];
        expect(binsPerTile * 2 ** ringStep, `level ${level}, band ${band}`).toBe(grid.tileFrames);
      }
    }
  });

  it("steps each band at the coarser of its own step and the level's", () => {
    const grid = tileGrid(handLayout([0, 2, 5], [64, 16, 2]), 64, 3);
    expect(Array.from(grid.metadata.filter((_, i) => i % 4 === 2))).toEqual([3, 3, 5]);
  });

  it("lays the bands out back to back inside a slot", () => {
    const grid = tileGrid(layout, layout.numFrames, 5);
    let offset = 0;
    for (let band = 0; band < layout.numBands; band++) {
      expect(grid.metadata[band * 4]).toBe(offset);
      offset += grid.metadata[band * 4 + 3];
    }
    expect(grid.tileTexels).toBe(offset);
  });

  it("counts a band's bins over the whole file at the ring's step", () => {
    const grid = tileGrid(layout, layout.numFrames, 6);
    for (let band = 0; band < layout.numBands; band++) {
      const sourceStep = layout.metadata[band * 4 + 2];
      const sourceLength = layout.metadata[band * 4 + 1];
      const decimation = 2 ** (grid.metadata[band * 4 + 2] - sourceStep);
      expect(grid.metadata[band * 4 + 1]).toBe(Math.ceil(sourceLength / decimation));
    }
  });

  it("holds enough tiles for the whole file", () => {
    for (const level of [0, 4, 9]) {
      const grid = tileGrid(layout, layout.numFrames, level);
      expect(grid.tileCount * grid.tileFrames).toBeGreaterThanOrEqual(layout.numFrames);
      expect((grid.tileCount - 1) * grid.tileFrames).toBeLessThan(layout.numFrames);
    }
  });
});

describe("ringLevelChoice", () => {
  it("takes the level whose bins are at least one per screen pixel", () => {
    expect(ringLevelChoice(1)).toEqual({ level: 0, blend: 0 });
    expect(ringLevelChoice(4)).toEqual({ level: 2, blend: 0 });
    expect(ringLevelChoice(256)).toEqual({ level: 8, blend: 0 });
  });

  it("blends towards the next level across the octave", () => {
    const choice = ringLevelChoice(2 ** 5.25);
    expect(choice.level).toBe(5);
    expect(choice.blend).toBeCloseTo(0.25, 6);
  });

  it("stays at the finest level when a pixel holds less than a frame", () => {
    expect(ringLevelChoice(0.1)).toEqual({ level: 0, blend: 0 });
  });
});

describe("ringSlotCount", () => {
  const layout = layoutOf(120);

  it("holds the viewport and its slack", () => {
    const grid = tileGrid(layout, layout.numFrames, 6);
    const slots = ringSlotCount(grid, VIEWPORT, DISPLAY_TILES_MAX_TEXELS);
    expect(slots * grid.tileFrames).toBeGreaterThan(VIEWPORT * 2 ** grid.level);
  });

  it("covers the view at the coarsest zoom the level serves", () => {
    const grid = tileGrid(layout, layout.numFrames, 6);
    const slots = ringSlotCount(grid, VIEWPORT, DISPLAY_TILES_MAX_TEXELS);
    // Just under the frames-per-pixel at which the next level takes over.
    const span = VIEWPORT * (2 ** (grid.level + 1) - 1e-3);
    const start = grid.tileFrames * 2 + 7;
    const window = ringWindow(grid, slots, start, start + span);
    expect(window.first).toBeLessThanOrEqual(Math.floor(start / grid.tileFrames));
    expect(window.first + window.count).toBeGreaterThan(Math.floor((start + span - 1) / grid.tileFrames));
  });

  it("never asks for more texels than the ring holds", () => {
    for (let level = 0; level <= 12; level++) {
      const grid = tileGrid(layout, layout.numFrames, level);
      const slots = ringSlotCount(grid, VIEWPORT, DISPLAY_TILES_MAX_TEXELS);
      expect(slots * grid.tileTexels, `level ${level}`).toBeLessThanOrEqual(DISPLAY_TILES_MAX_TEXELS);
    }
  });

  it("gives up when the ring cannot hold enough tiles to be read", () => {
    const grid = tileGrid(layout, layout.numFrames, 0);
    expect(ringSlotCount(grid, VIEWPORT, grid.tileTexels * 2)).toBe(0);
    expect(ringSlotCount(grid, VIEWPORT, grid.tileTexels * 3)).toBe(3);
  });

  it("asks for no more tiles than the file has", () => {
    const short = layoutOf(0.05);
    const grid = tileGrid(short, short.numFrames, 0);
    expect(ringSlotCount(grid, VIEWPORT, DISPLAY_TILES_MAX_TEXELS)).toBe(grid.tileCount);
  });
});

describe("ringWindow", () => {
  const layout = layoutOf(120);
  const grid = tileGrid(layout, layout.numFrames, 4);

  it("covers every tile the view touches", () => {
    const start = grid.tileFrames * 3.5;
    const window = ringWindow(grid, 6, start, start + grid.tileFrames * 1.5);
    expect(window.first).toBeLessThanOrEqual(3);
    expect(window.first + window.count).toBeGreaterThan(5);
  });

  it("centres the slack on the view", () => {
    const start = grid.tileFrames * 10;
    const window = ringWindow(grid, 6, start, start + grid.tileFrames);
    expect(window.first).toBe(8);
    expect(window.count).toBe(6);
  });

  it("keeps a window that still covers the view", () => {
    const current = { first: 8, count: 6 };
    const start = grid.tileFrames * 11;
    expect(ringWindow(grid, 6, start, start + grid.tileFrames, current)).toBe(current);
  });

  it("slides when the view leaves the window", () => {
    const current = { first: 8, count: 6 };
    const start = grid.tileFrames * 14;
    const window = ringWindow(grid, 6, start, start + grid.tileFrames, current);
    expect(window.first).toBeGreaterThan(current.first);
    expect(window.first).toBeLessThanOrEqual(14);
    expect(window.first + window.count).toBeGreaterThan(14);
  });

  it("stops at both ends of the file", () => {
    expect(ringWindow(grid, 6, 0, grid.tileFrames).first).toBe(0);
    const last = ringWindow(grid, 6, layout.numFrames - 1, layout.numFrames);
    expect(last.first + last.count).toBe(grid.tileCount);
  });

  it("holds nothing without a slot", () => {
    expect(ringWindow(grid, 0, 0, layout.numFrames)).toEqual({ first: 0, count: 0 });
  });
});

describe("ring size", () => {
  it("costs the same whatever the file's length", () => {
    const rows = Math.ceil(DISPLAY_TILES_MAX_TEXELS / 8192);
    expect(displayTilesBytes()).toBe(rows * 8192 * DISPLAY_TILES_BYTES_PER_TEXEL);
  });

  it("charges the rows the ring's texture really allocates", () => {
    expect(displayTilesBytes(100_000)).toBe(13 * 8192 * DISPLAY_TILES_BYTES_PER_TEXEL);
  });

  it("covers a viewport at every level of an hour-long file", () => {
    const layout = layoutOf(3600);
    for (let level = 0; level <= 16; level++) {
      const grid = tileGrid(layout, layout.numFrames, level);
      const slots = ringSlotCount(grid, VIEWPORT, DISPLAY_TILES_MAX_TEXELS);
      expect(slots, `level ${level}`).toBeGreaterThan(0);
      // The worst view the level serves sits just under 2^(level+1) frames
      // per pixel; the slots must cover it, or the whole file if that is less.
      const worst = Math.min(VIEWPORT * (2 ** (level + 1) - 1), layout.numFrames);
      expect(slots * grid.tileFrames, `level ${level}`).toBeGreaterThanOrEqual(worst);
    }
  });
});
