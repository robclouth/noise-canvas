import { describe, expect, it } from "vitest";

import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { layoutTexels } from "../band-layout";
import { blockGrid, blockPixelRanges } from "../block-grid";
import { BlockStore, type BlockBackend, type BlockCodec } from "../block-store";
import { gatherPixelRanges } from "../pixel-ranges";

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
  const store = new BlockStore(grid, backend, {
    codec: opts.codec ?? rawCodec,
    maxResidentBytes: opts.maxResidentBytes ?? 1 << 30,
    texelCount: data.textureWidth * data.textureHeight,
  });
  await store.seed(packed);
  return { grid, backend, store };
}

/** The pixels of one band, as a sorted range list a footprint would carry. */
function bandRange(band: number, firstBin: number, bins: number): Uint32Array {
  return Uint32Array.of(layout.metadata[band * 4] + firstBin, bins);
}

describe("BlockStore", () => {
  it("gives back everything it was seeded with", async () => {
    const { store } = await seeded();
    const all = await store.readAll();
    expect(all.length).toBe(packed.length);
    expect(Array.from(all)).toEqual(Array.from(packed));
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
    expect(Array.from(await store.readAll())).toEqual(Array.from(expected));
  });

  it("holds a patch until it is flushed, then writes it", async () => {
    const { grid, backend, store } = await seeded();
    const before = backend.writes;
    const ranges = Uint32Array.of(...bandRange(1, 40, 200));
    const values = gatherPixelRanges(packed, ranges).map((value) => value * -1);

    await store.patch(ranges, values);
    expect(store.dirtyCount).toBeGreaterThan(0);
    expect(backend.writes).toBe(before);

    await store.flush();
    expect(store.dirtyCount).toBe(0);
    expect(backend.writes).toBeGreaterThan(before);
    expect(backend.writes - before).toBeLessThan(grid.blockCount);

    // A fresh store over the same bytes sees the patch, so it reached the backend.
    const reopened = new BlockStore(grid, backend, { codec: rawCodec });
    expect(Array.from(await reopened.readRanges(ranges))).toEqual(Array.from(values));
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

  it("refuses a block that was never written", async () => {
    const grid = makeGrid();
    const store = new BlockStore(grid, memoryBackend(), { codec: rawCodec });
    await expect(store.read([0])).rejects.toThrow(/never written/);
  });

  it("cannot be read after it is disposed", async () => {
    const { backend, store } = await seeded();
    await store.dispose();
    expect(backend.blocks.size).toBe(0);
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
