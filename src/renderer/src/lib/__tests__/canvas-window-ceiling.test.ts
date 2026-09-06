import { beforeAll, describe, expect, it } from "vitest";
import { blockGrid, type BlockGrid } from "../block-grid";
import { canvasWindowBlocks } from "../gpu-budget";
import { MAX_PACKED_TEXTURE_TEXELS } from "../constants";
import { needsCanvasWindow } from "../canvas-window";

// The canvas is a pair of textures, so a file with more coefficients than one
// texture holds can never lay its whole state on it. The graphics budget alone
// would keep the whole file on a machine with memory to spare, and then the
// allocation would fail. This runs in its own file because the GPU figure is
// read once and cached for the life of the module.

const SAMPLE_RATE = 44100;
const HUGE_GPU_BYTES = 256 * 1024 ** 3;

/** A synthetic constant-Q grid: 20 bands, doubling the time step every two. */
function gridOf(seconds: number): BlockGrid {
  const numBands = 20;
  const numFrames = Math.round(seconds * SAMPLE_RATE);
  const metadata = new Float64Array(numBands * 4);
  let offset = 0;
  for (let band = 0; band < numBands; band++) {
    const step = Math.min(9, Math.floor(band / 2));
    const length = Math.ceil(numFrames / 2 ** step);
    metadata[band * 4] = offset;
    metadata[band * 4 + 1] = length;
    metadata[band * 4 + 2] = step;
    metadata[band * 4 + 3] = 20 * 2 ** (band / 4);
    offset += length;
  }
  return blockGrid({ numBands, metadata }, numFrames, SAMPLE_RATE, 2);
}

function texelsOf(grid: BlockGrid): number {
  let texels = 0;
  for (let band = 0; band < grid.layout.numBands; band++) texels += grid.layout.metadata[band * 4 + 1];
  return texels;
}

describe("the canvas window a file too big for one texture must take", () => {
  beforeAll(() => {
    const w = window as unknown as Record<string, unknown>;
    w.nodeOs = { homedir: () => "/home", totalmem: () => 512 * 1024 ** 3 };
    w.audioAnalysis = { getGpuMemoryInfo: () => ({ bytes: HUGE_GPU_BYTES, unified: true }) };
  });

  it("keeps the whole file while its coefficients fit one texture", () => {
    const grid = gridOf(300);
    expect(texelsOf(grid)).toBeLessThan(MAX_PACKED_TEXTURE_TEXELS);
    expect(canvasWindowBlocks(grid)).toBe(Infinity);
  });

  it("windows a file past one texture even where the budget would hold all of it", () => {
    const grid = gridOf(600);
    expect(texelsOf(grid)).toBeGreaterThan(MAX_PACKED_TEXTURE_TEXELS);
    const blocks = canvasWindowBlocks(grid);
    expect(blocks).toBeLessThan(grid.blockCount);
    expect(needsCanvasWindow(grid, blocks)).toBe(true);
  });
});
