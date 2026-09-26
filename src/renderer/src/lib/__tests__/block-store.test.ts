import { describe, expect, it } from "vitest";

import { applyPhaseTurnsCollecting } from "../../../../main/lib/history-delta";
import type { PhaseTurns } from "../../../../main/lib/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { layoutTexels } from "../band-layout";
import { blockGrid, blockPixelRanges } from "../block-grid";
import { BlockStore, type BlockBackend, type BlockCodec } from "../block-store";
import { gatherPixelRanges, gatherTaps } from "../pixel-ranges";

const SAMPLE_RATE = 8000;
const data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: SAMPLE_RATE, bandsPerOctave: 4 });
const layout = { numBands: data.numBands, metadata: data.metadata };

// The mock's magnitude is the same everywhere, which hides a pixel copied from
// the wrong place; this varies every channel along the packed layout. The
// texture's padding past the last band stays zero, as the analysis leaves it.
const packed = Float32Array.from(data.packedData);
for (let i = 0; i < layoutTexels(layout) * 4; i++) packed[i] = Math.sin(i * 0.017) * 0.5 + 0.5;

function makeGrid(targetSeconds = 0.25) {
  return blockGrid(layout, data.numFrames, SAMPLE_RATE, targetSeconds);
}

/** A backend in RAM, counting what the store asks of it. */
function memoryBackend(): BlockBackend & { reads: number; writes: number; blocks: Map<number, Uint8Array> } {
  const blocks = new Map<number, Uint8Array>();
  return {
    blocks,
    reads: 0,
    writes: 0,
    async read(index) {
      this.reads++;
      return blocks.get(index) ?? null;
    },
    async write(index, bytes) {
      this.writes++;
      blocks.set(index, bytes.slice());
    },
    async clear() {
      blocks.clear();
    },
  };
}

/** The coefficients as their own bytes, so a test measures the store and not a codec. */
const rawCodec: BlockCodec = {
  async encode(block) {
    return new Uint8Array(block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength));
  },
  async decode(bytes) {
    const copy = bytes.slice();
    return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  },
};

async function seeded(opts: { targetSeconds?: number; maxResidentBytes?: number; codec?: BlockCodec } = {}) {
  const grid = makeGrid(opts.targetSeconds);
  const backend = memoryBackend();
  const overlay = memoryBackend();
  const store = new BlockStore(grid, backend, {
    codec: opts.codec ?? rawCodec,
    maxResidentBytes: opts.maxResidentBytes ?? 1 << 30,
    overlay,
    texelCount: data.texels,
  });
  await store.seed(packed);
  return { grid, backend, overlay, store };
}

/** The pixels of one band, as a sorted range list a footprint would carry. */
function bandRange(band: number, firstBin: number, bins: number): Uint32Array {
  return Uint32Array.of(layout.metadata[band * 4] + firstBin, bins);
}

// Whole-array mismatches are asserted through this index rather than a
// toEqual, whose failure diff over ~70k elements wedges the browser runner.
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

describe("BlockStore", () => {
  it("counts each decoded original block once and releases it on disposal", async () => {
    const { store } = await seeded();
    const currentBytes = store.residentBytes;
    const original = await store.readRootBlock(0);
    expect(store.residentBytes).toBe(currentBytes + original.byteLength);
    await store.readRootBlock(0);
    expect(store.residentBytes).toBe(currentBytes + original.byteLength);
    await store.dispose();
    expect(store.residentBytes).toBe(0);
  });

  it("gives back everything it was seeded with", async () => {
    const { store } = await seeded();
    const all = await store.readAll();
    expect(all.length).toBe(packed.length);
    expect(firstDifference(all, packed)).toBe(-1);
  });

  it("takes its blocks one at a time, and knows when it holds the file", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    const store = new BlockStore(grid, backend, { codec: rawCodec, texelCount: data.texels });
    expect(store.isSeeded).toBe(false);

    const asked: number[] = [];
    await store.seedFrom(async (index) => {
      asked.push(index);
      return gatherPixelRanges(packed, store.blockRanges(index));
    });

    expect(asked).toEqual([...Array(grid.blockCount).keys()]);
    expect(store.isSeeded).toBe(true);
    expect(firstDifference(await store.readAll(), packed)).toBe(-1);
  });

  it("refuses a block cut for another grid", async () => {
    const grid = makeGrid();
    const store = new BlockStore(grid, memoryBackend(), { codec: rawCodec, texelCount: data.texels });
    await expect(store.seedFrom(async () => new Float32Array(8))).rejects.toThrow(/expected/);
  });

  it("writes one file per block", async () => {
    const { grid, backend } = await seeded();
    expect(backend.blocks.size).toBe(grid.blockCount);
    expect(grid.blockCount).toBeGreaterThan(4);
  });

  it("reads a block as the pixels that block claims", async () => {
    const { grid, store } = await seeded();
    const [block] = await store.read([3]);
    const list = blockPixelRanges(grid, 3);
    expect(Array.from(block)).toEqual(Array.from(gatherPixelRanges(packed, list.ranges.subarray(0, list.count * 2))));
  });

  it("reads a range list as the same pixels the whole array holds", async () => {
    const { store } = await seeded();
    const ranges = Uint32Array.of(...bandRange(0, 100, 3000), ...bandRange(5, 7, 90));
    expect(Array.from(await store.readRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
  });

  it("reads strided taps across blocks as the whole array holds them", async () => {
    const { grid, store } = await seeded();
    const bins = grid.binsPerBlock[0];
    const [first] = bandRange(0, bins - 7, 1);
    const [second] = bandRange(5, 3, 1);
    const runs = Uint32Array.of(first, Math.floor((bins * 3) / 16), 16, second, 20, 3);
    expect(Array.from(await store.readTaps(runs))).toEqual(Array.from(gatherTaps(packed, runs)));
  });

  it("reads a range that spans several blocks", async () => {
    const { grid, store } = await seeded();
    const bins = grid.binsPerBlock[0];
    const ranges = bandRange(0, bins - 5, bins * 3 + 10);
    expect(Array.from(await store.readRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
  });

  it("keeps a patch, and leaves every other pixel alone", async () => {
    const { store } = await seeded();
    const ranges = Uint32Array.of(...bandRange(1, 40, 200));
    const values = gatherPixelRanges(packed, ranges).map((value) => value * -1);
    await store.patch(ranges, values);

    expect(Array.from(await store.readRanges(ranges))).toEqual(Array.from(values));
    const expected = Float32Array.from(packed);
    const start = ranges[0] * 4;
    expected.set(values, start);
    expect(firstDifference(await store.readAll(), expected)).toBe(-1);
  });

  it("applies tail turns block by block, exactly as the whole-array walk", async () => {
    const { grid, backend, overlay, store } = await seeded();
    const turns: PhaseTurns = {
      pixelStarts: Uint32Array.of(layout.metadata[0] + 8, layout.metadata[2 * 4] + 4),
      pixelCounts: Uint32Array.of(layout.metadata[1] - 8, layout.metadata[2 * 4 + 1] - 4),
      offsets: Float32Array.from([Math.fround(2 * Math.PI), Math.fround(-2 * Math.PI), 0, Math.fround(6 * Math.PI)]),
      residuals: new Uint32Array(0),
    };
    const expected = Float32Array.from(packed);
    const expectedResiduals = applyPhaseTurnsCollecting(expected, turns);
    expect(expectedResiduals.length).toBeGreaterThan(0);

    const residuals = await store.applyTurnsCollecting(turns);
    expect(firstDifference(residuals, expectedResiduals)).toBe(-1);
    expect(firstDifference(await store.readAll(), expected)).toBe(-1);

    // The turned blocks reach disk on the next flush, so a reopened store
    // holds them too.
    await store.flush();
    const reopened = new BlockStore(grid, backend, {
      codec: rawCodec,
      maxResidentBytes: 1 << 30,
      overlay,
      texelCount: data.texels,
    });
    expect(firstDifference(await reopened.readAll(), expected)).toBe(-1);
  });

  it("holds a patch until it is flushed, then writes it", async () => {
    const { grid, backend, overlay, store } = await seeded();
    const before = overlay.writes;
    const ranges = Uint32Array.of(...bandRange(1, 40, 200));
    const values = gatherPixelRanges(packed, ranges).map((value) => value * -1);

    await store.patch(ranges, values);
    expect(store.dirtyCount).toBeGreaterThan(0);
    expect(overlay.writes).toBe(before);

    await store.flush();
    expect(store.dirtyCount).toBe(0);
    expect(overlay.writes).toBeGreaterThan(before);
    expect(overlay.writes - before).toBeLessThan(grid.blockCount);

    // A fresh store over the same bytes sees the patch, so it reached the backend.
    const reopened = new BlockStore(grid, backend, { codec: rawCodec, overlay });
    expect(Array.from(await reopened.readRanges(ranges))).toEqual(Array.from(values));
  });

  it("flushes patches into the overlay and never rewrites a seeded block", async () => {
    const { grid, backend, overlay, store } = await seeded();
    const rootWrites = backend.writes;
    const ranges = Uint32Array.of(...bandRange(1, 40, 200));
    const values = gatherPixelRanges(packed, ranges).map((value) => value * -1);
    await store.patch(ranges, values);
    await store.flush();

    expect(backend.writes).toBe(rootWrites);
    expect(overlay.blocks.size).toBeGreaterThan(0);

    // A store over the seeded blocks alone still holds the state before the patch.
    const rootOnly = new BlockStore(grid, backend, { codec: rawCodec });
    expect(Array.from(await rootOnly.readRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
  });

  it("reseeds the current tier without touching the seeded blocks", async () => {
    const { backend, overlay, store } = await seeded();
    const rootWrites = backend.writes;
    const replaced = packed.map((value) => value * -1);
    await store.seedCurrent(replaced);

    expect(backend.writes).toBe(rootWrites);
    expect(overlay.blocks.size).toBeGreaterThan(0);
    expect(firstDifference(await store.readAll(), replaced)).toBe(-1);
    expect(firstDifference(await store.readAllRoot(), packed)).toBe(-1);
  });

  it("reads the seeded state back from under a flushed patch", async () => {
    const { store } = await seeded();
    const all = Uint32Array.of(0, layoutTexels(layout));
    await store.patch(
      all,
      gatherPixelRanges(packed, all).map((value) => value * -1),
    );
    await store.flush();
    const root = await store.readAllRoot();
    expect(root.length).toBe(packed.length);
    expect(firstDifference(root, packed)).toBe(-1);
  });

  it("reads a range list of the seeded state from under an unflushed patch", async () => {
    const { store } = await seeded();
    const ranges = Uint32Array.of(...bandRange(1, 40, 200), ...bandRange(4, 0, 500));
    const values = gatherPixelRanges(packed, ranges).map((value) => value * -1);
    await store.patch(ranges, values);
    expect(Array.from(await store.readRootRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
  });

  it("answers the seeded state of an untouched block without a read", async () => {
    const { backend, overlay, store } = await seeded();
    const ranges = Uint32Array.of(...bandRange(2, 10, 300));
    await store.readRootRanges(ranges);
    const reads = backend.reads + overlay.reads;
    expect(Array.from(await store.readRootRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
    expect(backend.reads + overlay.reads).toBe(reads);
  });

  it("keeps a seeded copy that a later patch cannot reach", async () => {
    const { store } = await seeded();
    const ranges = Uint32Array.of(...bandRange(2, 10, 300));
    await store.readRootRanges(ranges);
    await store.patch(
      ranges,
      gatherPixelRanges(packed, ranges).map((value) => value * -1),
    );
    expect(Array.from(await store.readRootRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
  });

  it("decodes the seeded state of a flushed block once", async () => {
    const { backend, store } = await seeded({ maxResidentBytes: 1 << 30 });
    const ranges = Uint32Array.of(...bandRange(1, 40, 200));
    await store.patch(
      ranges,
      gatherPixelRanges(packed, ranges).map((value) => value * -1),
    );
    await store.flush();
    const before = backend.reads;
    expect(Array.from(await store.readRootRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
    expect(backend.reads).toBe(before + 1);
    expect(Array.from(await store.readRootRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
    expect(backend.reads).toBe(before + 1);
  });

  it("tells the codec how many bytes a block decodes to", async () => {
    const sizes: Array<number | undefined> = [];
    const codec: BlockCodec = {
      encode: rawCodec.encode,
      async decode(bytes, decodedBytes) {
        sizes.push(decodedBytes);
        return await rawCodec.decode(bytes);
      },
    };
    const { grid, store } = await seeded({ codec, maxResidentBytes: 1 << 20 });
    const list = blockPixelRanges(grid, 1);
    const ranges = list.ranges.slice(0, list.count * 2);
    let texels = 0;
    for (let i = 1; i < ranges.length; i += 2) texels += ranges[i];
    await store.readRanges(ranges);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((size) => size === texels * 16)).toBe(true);
  });

  it("answers a patched block from RAM, not from the bytes it was written as", async () => {
    const { backend, store } = await seeded();
    const ranges = Uint32Array.of(...bandRange(1, 40, 200));
    const values = gatherPixelRanges(packed, ranges).map((value) => value * -1);
    await store.patch(ranges, values);
    const before = backend.reads;
    expect(Array.from(await store.readRanges(ranges))).toEqual(Array.from(values));
    expect(backend.reads).toBe(before);
  });

  it("keeps a block dirty when a patch lands while it is being written", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdEncodes = false;
    const slow: BlockCodec = {
      async encode(block) {
        if (holdEncodes) await gate;
        return await rawCodec.encode(block);
      },
      decode: rawCodec.decode,
    };
    const store = new BlockStore(grid, backend, { codec: slow });
    await store.seed(packed);

    const first = Uint32Array.of(...bandRange(1, 40, 200));
    const firstValues = gatherPixelRanges(packed, first).map((value) => value * -1);
    await store.patch(first, firstValues);

    holdEncodes = true;
    const flushing = store.flush();
    const second = Uint32Array.of(...bandRange(1, 40, 200));
    const secondValues = gatherPixelRanges(packed, second).map((value) => value * 3);
    await store.patch(second, secondValues);
    release();
    await flushing;
    holdEncodes = false;

    expect(store.dirtyCount).toBe(1);
    await store.flush();
    expect(store.dirtyCount).toBe(0);
    const reopened = new BlockStore(grid, backend, { codec: rawCodec });
    expect(Array.from(await reopened.readRanges(second))).toEqual(Array.from(secondValues));
  });

  it("replaces unflushed patches when it is seeded again", async () => {
    const { store } = await seeded();
    const ranges = Uint32Array.of(...bandRange(1, 40, 200));
    await store.patch(
      ranges,
      gatherPixelRanges(packed, ranges).map((value) => value * -1),
    );
    await store.seed(packed);
    expect(store.dirtyCount).toBe(0);
    expect(Array.from(await store.readRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
  });

  it("drops the overlay when it is seeded again", async () => {
    const { overlay, store } = await seeded();
    const ranges = Uint32Array.of(...bandRange(1, 40, 200));
    await store.patch(
      ranges,
      gatherPixelRanges(packed, ranges).map((value) => value * -1),
    );
    await store.flush();
    expect(overlay.blocks.size).toBeGreaterThan(0);

    await store.seed(packed);
    expect(overlay.blocks.size).toBe(0);
    expect(Array.from(await store.readRanges(ranges))).toEqual(Array.from(gatherPixelRanges(packed, ranges)));
  });

  it("finishes an in-flight flush before it reseeds the current tier", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    const overlay = memoryBackend();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => {};
    const flushParked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let gated = true;
    const slowOverlay: BlockBackend = {
      read: (index) => overlay.read(index),
      write: async (index, bytes) => {
        if (gated) {
          gated = false;
          reached();
          await gate;
        }
        await overlay.write(index, bytes);
      },
      clear: () => overlay.clear(),
    };
    const store = new BlockStore(grid, backend, {
      codec: rawCodec,
      maxResidentBytes: 1 << 30,
      overlay: slowOverlay,
      texelCount: data.texels,
    });
    await store.seed(packed);

    const ranges = bandRange(0, 0, 4);
    await store.patch(ranges, new Float32Array(4 * 4).fill(0.25));
    const flushing = store.flush();
    await flushParked;

    const reseeded = packed.map((value) => Math.fround(value * 0.5 + 0.1));
    const seeding = store.seedCurrent(reseeded);
    release();
    await Promise.all([flushing, seeding]);

    const expected = gatherPixelRanges(reseeded, store.blockRanges(0));
    expect(firstDifference(await rawCodec.decode(overlay.blocks.get(0)!), expected)).toBe(-1);
  });

  it("writes bytes a mid-encode patch cannot tear", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    const slow: BlockCodec = {
      async encode(block) {
        if (hold) {
          hold = false;
          await gate;
        }
        return await rawCodec.encode(block);
      },
      decode: rawCodec.decode,
    };
    const store = new BlockStore(grid, backend, { codec: slow });
    await store.seed(packed);
    const ranges = Uint32Array.of(...bandRange(1, 40, 200));
    const first = gatherPixelRanges(packed, ranges).map((value) => value * -1);
    await store.patch(ranges, first);

    hold = true;
    const flushing = store.flush();
    const second = gatherPixelRanges(packed, ranges).map((value) => value * 3);
    await store.patch(ranges, second);
    release();
    await flushing;

    // The bytes on disk hold the state the flush saw, whole, not the patch.
    const reopened = new BlockStore(grid, backend, { codec: rawCodec });
    expect(Array.from(await reopened.readRanges(ranges))).toEqual(Array.from(first));
  });

  it("keeps what it has cached through a read over more than it can hold", async () => {
    // Many more blocks than the read keeps in flight, so evictions land between loads.
    const grid = makeGrid(0.02);
    expect(grid.blockCount).toBeGreaterThanOrEqual(32);
    const backend = memoryBackend();
    await new BlockStore(grid, backend, { codec: rawCodec }).seed(packed);
    const total = layoutTexels(layout) * 16;
    const reader = new BlockStore(grid, backend, { codec: rawCodec, maxResidentBytes: Math.floor(total / 2) });
    const all = Uint32Array.of(0, layoutTexels(layout));
    await reader.readRanges(all);
    const first = backend.reads;
    const again = await reader.readRanges(all);
    // Evicting as the read went would leave the second read nothing cached.
    expect(backend.reads - first).toBeLessThan(grid.blockCount * 0.75);
    expect(Array.from(again)).toEqual(Array.from(gatherPixelRanges(packed, all)));
  });

  it("stops an in-flight flush when it is disposed, leaving nothing behind", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => {};
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let hold = false;
    const slow: BlockCodec = {
      async encode(block) {
        if (hold) {
          hold = false;
          reached();
          await gate;
        }
        return await rawCodec.encode(block);
      },
      decode: rawCodec.decode,
    };
    const store = new BlockStore(grid, backend, { codec: slow });
    await store.seed(packed);
    const inFirst = Uint32Array.of(...bandRange(0, 5, 20));
    const inFourth = Uint32Array.of(...bandRange(0, grid.binsPerBlock[0] * 3 + 5, 20));
    await store.patch(
      inFirst,
      gatherPixelRanges(packed, inFirst).map((value) => value * -1),
    );
    await store.patch(
      inFourth,
      gatherPixelRanges(packed, inFourth).map((value) => value * -1),
    );
    expect(store.dirtyCount).toBe(2);

    hold = true;
    const writesBefore = backend.writes;
    const flushing = store.flush();
    // Dispose lands while the flush is inside its first encode.
    await held;
    const disposing = store.dispose();
    release();
    await Promise.all([flushing, disposing]);

    // The flush gives up after the block it was writing; dispose then clears
    // the backend behind it.
    expect(backend.writes - writesBefore).toBeLessThanOrEqual(1);
    expect(backend.blocks.size).toBe(0);
    expect(store.residentBytes).toBe(0);
  });

  it("flushes itself rather than hold every patched block in RAM", async () => {
    const { overlay, store } = await seeded({ maxResidentBytes: 1 << 16 });
    const writesBefore = overlay.writes;
    const all = Uint32Array.of(0, layoutTexels(layout));
    const values = gatherPixelRanges(packed, all).map((value) => value * -1);
    await store.patch(all, values);

    expect(overlay.writes).toBeGreaterThan(writesBefore);
    expect(store.residentBytes).toBeLessThanOrEqual(1 << 16);
    expect(firstDifference(await store.readRanges(all), values)).toBe(-1);
  });

  it("drops clean blocks to stay inside its budget", async () => {
    const { grid, store } = await seeded({ maxResidentBytes: 1 << 16 });
    await store.readAll();
    expect(store.residentBytes).toBeLessThanOrEqual(1 << 16);
    expect(grid.blockCount).toBeGreaterThan(4);
  });

  it("still reads a block after its RAM copy was dropped", async () => {
    const { grid, backend, store } = await seeded({ maxResidentBytes: 1 << 16 });
    await store.readAll();
    const [block] = await store.read([0]);
    const list = blockPixelRanges(grid, 0);
    expect(Array.from(block)).toEqual(Array.from(gatherPixelRanges(packed, list.ranges.subarray(0, list.count * 2))));
    expect(backend.reads).toBeGreaterThan(0);
  });

  it("decodes a block once when several reads ask for it together", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    let decodes = 0;
    const counting: BlockCodec = {
      encode: rawCodec.encode,
      async decode(bytes) {
        decodes++;
        return await rawCodec.decode(bytes);
      },
    };
    const store = new BlockStore(grid, backend, { codec: counting });
    await store.seed(packed);
    // Seeding leaves the blocks resident; a fresh store over the same bytes
    // has to go to the backend.
    const cold = new BlockStore(grid, backend, { codec: counting });
    decodes = 0;
    await Promise.all([cold.read([2]), cold.read([2]), cold.read([2, 2])]);
    expect(decodes).toBe(1);
  });

  it("refuses a block whose bytes were cut for another grid", async () => {
    const { grid, backend } = await seeded();
    backend.blocks.set(0, await rawCodec.encode(new Float32Array(3)));
    const cold = new BlockStore(grid, backend, { codec: rawCodec });
    await expect(cold.read([0])).rejects.toThrow(/expected/);
    await expect(cold.readAllRoot()).rejects.toThrow(/expected/);
  });

  it("refuses a block that was never written", async () => {
    const grid = makeGrid();
    const store = new BlockStore(grid, memoryBackend(), { codec: rawCodec });
    await expect(store.read([0])).rejects.toThrow(/never written/);
  });

  it("cannot be read after it is disposed", async () => {
    const { backend, overlay, store } = await seeded();
    const ranges = Uint32Array.of(...bandRange(1, 40, 200));
    await store.patch(
      ranges,
      gatherPixelRanges(packed, ranges).map((value) => value * -1),
    );
    await store.flush();
    await store.dispose();
    expect(backend.blocks.size).toBe(0);
    expect(overlay.blocks.size).toBe(0);
    await expect(store.readAll()).rejects.toThrow(/disposed/);
  });

  it("keeps a patch that lands while a block is being decoded", async () => {
    const grid = makeGrid();
    const backend = memoryBackend();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const slow: BlockCodec = {
      encode: rawCodec.encode,
      async decode(bytes) {
        if (!held) {
          held = true;
          await gate;
        }
        return await rawCodec.decode(bytes);
      },
    };
    const store = new BlockStore(grid, backend, { codec: rawCodec });
    await store.seed(packed);

    const cold = new BlockStore(grid, backend, { codec: slow });
    const ranges = bandRange(0, 5, 20);
    const values = gatherPixelRanges(packed, ranges).map((value) => value * -1);
    const reading = cold.read([0]);
    const patching = cold.patch(ranges, values);
    release();
    await Promise.all([reading, patching]);
    expect(Array.from(await cold.readRanges(ranges))).toEqual(Array.from(values));
  });
});
