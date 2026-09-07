import { describe, expect, it } from "vitest";

import { applyPhaseTurnsCollecting } from "../../../../main/lib/history-delta";
import type { PhaseTurns } from "../../../../main/lib/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { layoutTexels } from "../band-layout";
import { blockGrid } from "../block-grid";
import type { BlockBackend, BlockCodec } from "../block-store";
import { gatherPixelRanges, gatherTaps } from "../pixel-ranges";
import { WholeStateStore } from "../whole-state-store";

const SAMPLE_RATE = 8000;
const data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: SAMPLE_RATE, bandsPerOctave: 4 });
const layout = { numBands: data.numBands, metadata: data.metadata };

// Every channel varies along the packed layout, so a pixel copied from the
// wrong place shows; the padding past the last band stays zero.
const packed = Float32Array.from(data.packedData);
for (let i = 0; i < layoutTexels(layout) * 4; i++) packed[i] = Math.sin(i * 0.017) * 0.5 + 0.5;

function makeGrid() {
  return blockGrid(layout, data.numFrames, SAMPLE_RATE, 0.25);
}

/** A backend in RAM whose writes can be held shut, counting what the store asks of it. */
function memoryBackend() {
  const blocks = new Map<number, Uint8Array>();
  let gate: Promise<void> | null = null;
  let open = (): void => {};
  const backend: BlockBackend & { blocks: Map<number, Uint8Array>; writes: number; hold(): void; release(): void } = {
    blocks,
    writes: 0,
    async read(index) {
      return blocks.get(index) ?? null;
    },
    async write(index, bytes) {
      if (gate) await gate;
      this.writes++;
      blocks.set(index, bytes.slice());
    },
    async clear() {
      blocks.clear();
    },
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
  };
  return backend;
}

const rawCodec: BlockCodec = {
  async encode(block) {
    return new Uint8Array(block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength));
  },
  async decode(bytes) {
    const copy = bytes.slice();
    return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  },
};

async function seeded() {
  const grid = makeGrid();
  const backend = memoryBackend();
  const store = new WholeStateStore(grid, backend, { codec: rawCodec, texelCount: data.texels });
  await store.seed(packed);
  return { grid, backend, store };
}

function bandRange(band: number, firstBin: number, bins: number): Uint32Array {
  return Uint32Array.of(layout.metadata[band * 4] + firstBin, bins);
}

function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

describe("WholeStateStore", () => {
  it("keeps its tier in RAM and gives back everything it was seeded with", async () => {
    const { store } = await seeded();
    expect(store.tierOnDisk).toBe(false);
    expect(store.isSeeded).toBe(true);
    expect(store.dirtyCount).toBe(0);
    expect(firstDifference(await store.readAll(), packed)).toBe(-1);
    expect(store.residentBytes).toBeGreaterThanOrEqual(packed.byteLength);
  });

  it("reads ranges and blocks as the pixels the whole array holds", async () => {
    const { grid, store } = await seeded();
    const ranges = Uint32Array.of(...bandRange(0, 100, 3000), ...bandRange(5, 7, 90));
    expect(Array.from(await store.readRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
    const block = await store.readBlock(3);
    expect(Array.from(block)).toEqual(Array.from(gatherPixelRanges(packed, store.blockRanges(3))));
    const [first] = bandRange(0, 100, 1);
    const runs = Uint32Array.of(first, 50, 8);
    expect(Array.from(await store.readTaps(runs))).toEqual(Array.from(gatherTaps(packed, runs)));
    expect(grid.blockCount).toBeGreaterThan(4);
  });

  it("writes the seeded blocks behind the seed, and flush waits for them", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    backend.hold();
    const store = new WholeStateStore(grid, backend, { codec: rawCodec, texelCount: data.texels });
    await store.seed(packed);
    expect(backend.writes).toBe(0);
    expect(firstDifference(await store.readAll(), packed)).toBe(-1);

    let flushed = false;
    const flush = store.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(flushed).toBe(false);
    backend.release();
    await flush;
    expect(backend.writes).toBe(grid.blockCount);
    expect(backend.blocks.size).toBe(grid.blockCount);
  });

  it("serves the seeded state from the tier until the blocks are written", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    backend.hold();
    const store = new WholeStateStore(grid, backend, { codec: rawCodec, texelCount: data.texels });
    await store.seed(packed);
    const ranges = bandRange(2, 4, 40);
    expect(Array.from(await store.readRootRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
    expect(firstDifference(await store.readAllRoot(), packed)).toBe(-1);
    expect(backend.writes).toBe(0);
    backend.release();
    await store.flush();
  });

  it("holds a patch back until the seeded state is written, then keeps both apart", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    backend.hold();
    const store = new WholeStateStore(grid, backend, { codec: rawCodec, texelCount: data.texels });
    await store.seed(packed);

    const ranges = bandRange(1, 10, 25);
    const values = new Float32Array(25 * 4).fill(-3);
    let patched = false;
    const patch = store.patch(ranges, values).then(() => {
      patched = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(patched).toBe(false);
    backend.release();
    await patch;

    const expected = Float32Array.from(packed);
    expected.set(values, ranges[0] * 4);
    expect(firstDifference(await store.readAll(), expected)).toBe(-1);
    expect(Array.from(await store.readRanges(ranges))).toEqual(Array.from(values));
    expect(Array.from(await store.readRootRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
    expect(firstDifference(await store.readAllRoot(), packed)).toBe(-1);
    expect(Array.from(await store.readRootBlock(0))).toEqual(
      Array.from(gatherPixelRanges(packed, store.blockRanges(0))),
    );
    expect(backend.writes).toBe(grid.blockCount);
  });

  it("applies tail turns exactly as the whole-array walk", async () => {
    const { store } = await seeded();
    const start = layout.metadata[2 * 4] + 3;
    const turns: PhaseTurns = {
      pixelStarts: Uint32Array.of(start, start + 700),
      pixelCounts: Uint32Array.of(500, 40),
      offsets: Float32Array.of(0.7, -1.3, 2.1, 0),
      residuals: new Uint32Array(0),
    };
    const expected = Float32Array.from(packed);
    const walked = applyPhaseTurnsCollecting(expected, turns);
    const residuals = await store.applyTurnsCollecting(turns);
    expect(Array.from(residuals)).toEqual(Array.from(walked));
    expect(firstDifference(await store.readAll(), expected)).toBe(-1);
    expect(firstDifference(await store.readAllRoot(), packed)).toBe(-1);
  });

  it("replaces the tier when the current state is seeded, and leaves the seeded state alone", async () => {
    const { store } = await seeded();
    const other = packed.map((value) => value * 0.5);
    await store.seedCurrent(other);
    expect(firstDifference(await store.readAll(), other)).toBe(-1);
    expect(firstDifference(await store.readAllRoot(), packed)).toBe(-1);
  });

  it("gives a reopened store the seeded state from its backend and no tier", async () => {
    const { grid, backend, store } = await seeded();
    await store.flush();
    const reopened = new WholeStateStore(grid, backend, { codec: rawCodec, texelCount: data.texels });
    expect(reopened.isSeeded).toBe(false);
    await expect(reopened.readAll()).rejects.toThrow(/no tier/);
    await expect(reopened.patch(bandRange(0, 0, 4), new Float32Array(16))).rejects.toThrow(/no tier/);
    expect(firstDifference(await reopened.readAllRoot(), packed)).toBe(-1);
    const other = packed.map((value) => value + 1);
    await reopened.seedCurrent(other);
    expect(firstDifference(await reopened.readAll(), other)).toBe(-1);
  });

  it("drops a write in flight when it is seeded again", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    backend.hold();
    const store = new WholeStateStore(grid, backend, { codec: rawCodec, texelCount: data.texels });
    await store.seed(packed);
    const other = packed.map((value) => value * 2);
    const reseed = store.seed(other);
    backend.release();
    await reseed;
    await store.flush();
    expect(firstDifference(await store.readAll(), other)).toBe(-1);
    expect(firstDifference(await store.readAllRoot(), other)).toBe(-1);
    for (let index = 0; index < grid.blockCount; index++) {
      const block = await rawCodec.decode(backend.blocks.get(index)!);
      expect(Array.from(block)).toEqual(Array.from(gatherPixelRanges(other, store.blockRanges(index))));
    }
  });

  it("refuses a block cut for another grid", async () => {
    const store = new WholeStateStore(makeGrid(), memoryBackend(), { codec: rawCodec, texelCount: data.texels });
    await expect(store.seedFrom(async () => new Float32Array(8))).rejects.toThrow(/expected/);
  });

  it("cannot be read after it is disposed, and leaves nothing behind", async () => {
    const { backend, store } = await seeded();
    await store.flush();
    await store.dispose();
    expect(backend.blocks.size).toBe(0);
    await expect(store.readAll()).rejects.toThrow(/disposed/);
    await expect(store.readRootRanges(bandRange(0, 0, 4))).rejects.toThrow(/disposed/);
  });
});
