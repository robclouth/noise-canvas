import type { PhaseTurns } from "../../../main/lib/types";
import { layoutTexels } from "./band-layout";
import { blockPixelRanges, blocksForPixelRanges, type BlockGrid } from "./block-grid";
import { ByteBudgetCache } from "./byte-budget-cache";
import { host } from "./host";
import {
  copyCompactOverlap,
  copyTapsFromCompact,
  gatherPixelRanges,
  pixelRangeCount,
  scatterCompactPixelRanges,
  tapCount,
  tapSpanRanges,
} from "./pixel-ranges";

/** Where a store keeps its encoded blocks between reads. */
export interface BlockBackend {
  read(index: number): Promise<Uint8Array | null>;
  /** True when the backend holds the block. Without it, a read stands in. */
  has?(index: number): Promise<boolean>;
  write(index: number, bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

/** How a block's coefficients turn into stored bytes and back. */
export interface BlockCodec {
  encode(block: Float32Array): Promise<Uint8Array>;
  /** `decodedBytes`, when given, is the byte length the block decodes to. */
  decode(bytes: Uint8Array, decodedBytes?: number): Promise<Float32Array>;
}

/** The addon's plane reorder plus zstd, both off the JS thread. */
export const packedBlockCodec: BlockCodec = {
  async encode(block) {
    const blob = await host.analysis.encodeHistorySnapshot(block);
    return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  },
  async decode(bytes, decodedBytes) {
    return await host.analysis.decodeHistorySnapshot(bytes, decodedBytes);
  },
};

/** Decoded blocks held in RAM at once, before the oldest clean one is dropped. */
export const DEFAULT_RESIDENT_BYTES = 64 * 1024 * 1024;

/** What a store keeps beyond its grid and its backend. */
export type BlockStoreOptions = {
  codec?: BlockCodec;
  maxResidentBytes?: number;
  /**
   * Where flushed patches land. With an overlay, the seeded blocks are never
   * rewritten — a torn write can only reach the overlay — and reads take the
   * overlay's copy of a block over the seeded one. Without one, flushes
   * rewrite the seeded blocks in place.
   */
  overlay?: BlockBackend;
  /**
   * Texels a whole packed array holds, padding included. `readAll` returns an
   * array of this size, so it drops straight into the readers that upload it
   * as a texture. Defaults to the coefficients alone.
   */
  texelCount?: number;
};

/**
 * A file's packed state: the tier the strokes patch, and the seeded state
 * the tier started from, both cut on one block grid. A block store keeps
 * both on disk; a file the canvas holds whole keeps its tier in RAM.
 */
export interface PackedStateStore {
  readonly grid: BlockGrid;
  /** True once every block of the seeded state is held, so the store speaks for the file. */
  readonly isSeeded: boolean;
  /** True when the tier outlives the process, so a manifest on disk may name the node it holds. */
  readonly tierOnDisk: boolean;
  readonly residentBytes: number;
  readonly dirtyCount: number;
  blockRanges(index: number): Uint32Array;
  seed(packed: Float32Array): Promise<void>;
  seedFrom(source: (index: number) => Promise<Float32Array>): Promise<void>;
  seedCurrent(packed: Float32Array): Promise<void>;
  /** One block of the tier, compact in block order. */
  readBlock(index: number): Promise<Float32Array>;
  /** One block as it was seeded, compact in block order. */
  readRootBlock(index: number): Promise<Float32Array>;
  readAll(): Promise<Float32Array>;
  readAllRoot(): Promise<Float32Array>;
  readRanges(ranges: Uint32Array): Promise<Float32Array>;
  readRootRanges(ranges: Uint32Array): Promise<Float32Array>;
  /**
   * The left and right magnitudes at the taps `runs` names — [startPixel,
   * count, stride] triples, sorted — two floats per tap in run order.
   */
  readTaps(runs: Uint32Array): Promise<Float32Array>;
  patch(ranges: Uint32Array, values: Float32Array): Promise<void>;
  applyTurnsCollecting(turns: PhaseTurns): Promise<Uint32Array>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * The packed coefficients of one file, held as blocks on disk with a bounded
 * set decoded in RAM. Readers ask for the pixels they need; only the blocks
 * those pixels fall in are decoded, so a longer file costs reads rather than
 * memory.
 */
export class BlockStore implements PackedStateStore {
  readonly grid: BlockGrid;
  readonly tierOnDisk = true;
  private readonly backend: BlockBackend;
  private readonly overlay: BlockBackend | null;
  private readonly codec: BlockCodec;
  private readonly clean: ByteBudgetCache<Float32Array>;
  // Seeded copies of blocks, kept apart from the resident ones that patches
  // mutate in place.
  private readonly root: ByteBudgetCache<Float32Array>;
  // Blocks a patch reached in this session, and whether the overlay held a
  // block from an earlier one; together they say when a block's seeded state
  // is its resident copy.
  private readonly everPatched = new Set<number>();
  private readonly overlayOnDisk = new Map<number, boolean>();
  private readonly dirty = new Map<number, Float32Array>();
  private readonly dirtyVersion = new Map<number, number>();
  private readonly inflight = new Map<number, Promise<Float32Array>>();
  private readonly ranges: Array<Uint32Array | undefined>;
  private readonly texelCount: number;
  private readonly maxResidentBytes: number;
  private flushing: Promise<void> = Promise.resolve();
  private disposed = false;
  private seeded = false;

  constructor(grid: BlockGrid, backend: BlockBackend, options: BlockStoreOptions = {}) {
    this.grid = grid;
    this.backend = backend;
    this.overlay = options.overlay ?? null;
    this.codec = options.codec ?? packedBlockCodec;
    this.texelCount = Math.max(options.texelCount ?? 0, layoutTexels(grid.layout));
    this.maxResidentBytes = options.maxResidentBytes ?? DEFAULT_RESIDENT_BYTES;
    this.clean = new ByteBudgetCache<Float32Array>(this.maxResidentBytes, (block) => block.byteLength);
    this.root = new ByteBudgetCache<Float32Array>(Math.floor(this.maxResidentBytes / 2), (block) => block.byteLength);
    this.ranges = new Array<Uint32Array | undefined>(grid.blockCount);
  }

  /** True once every block has been written, so the store speaks for the file. */
  get isSeeded(): boolean {
    return this.seeded;
  }

  /** Bytes the decoded blocks hold, clean and dirty together. */
  get residentBytes(): number {
    let bytes = this.clean.byteCount;
    for (const block of this.dirty.values()) bytes += block.byteLength;
    return bytes;
  }

  /** Blocks changed since the last flush. */
  get dirtyCount(): number {
    return this.dirty.size;
  }

  /** One block's packed pixel ranges, built once and kept. */
  blockRanges(index: number): Uint32Array {
    const cached = this.ranges[index];
    if (cached) return cached;
    const list = blockPixelRanges(this.grid, index);
    const built = list.ranges.slice(0, list.count * 2);
    this.ranges[index] = built;
    return built;
  }

  /**
   * Writes the whole packed state out block by block, encoding each as it
   * goes so no more than one block's bytes are held beyond the cache. It
   * replaces whatever the store held.
   */
  async seed(packed: Float32Array): Promise<void> {
    await this.seedFrom((index) => Promise.resolve(gatherPixelRanges(packed, this.blockRanges(index))));
  }

  /**
   * Writes the store's blocks out one at a time, taking each from `source`
   * rather than cutting it from a run of the whole file. It replaces whatever
   * the store held.
   */
  async seedFrom(source: (index: number) => Promise<Float32Array>): Promise<void> {
    if (this.disposed) throw new Error("block store is disposed");
    // An in-flight flush finishes first, so none of its writes can land over
    // the reseeded blocks.
    await this.flushing;
    this.dirty.clear();
    this.dirtyVersion.clear();
    this.clean.clear();
    this.root.clear();
    this.everPatched.clear();
    this.overlayOnDisk.clear();
    await this.overlay?.clear();
    // One block's encode and write run while the next is read from the source.
    let writing: Promise<void> = Promise.resolve();
    for (let index = 0; index < this.grid.blockCount; index++) {
      const block = this.checked(index, await source(index));
      await writing;
      writing = this.codec.encode(block).then((bytes) => this.backend.write(index, bytes));
      this.clean.set(String(index), block);
    }
    await writing;
    this.seeded = true;
  }

  /**
   * Writes the whole packed state into the current tier block by block,
   * replacing whatever unflushed patches the store held. The seeded blocks
   * stay as they are.
   */
  async seedCurrent(packed: Float32Array): Promise<void> {
    if (this.disposed) throw new Error("block store is disposed");
    // An in-flight flush finishes first, so none of its writes can land over
    // the reseeded blocks.
    await this.flushing;
    this.dirty.clear();
    this.dirtyVersion.clear();
    this.clean.clear();
    for (let index = 0; index < this.grid.blockCount; index++) {
      const block = gatherPixelRanges(packed, this.blockRanges(index));
      this.everPatched.add(index);
      await (this.overlay ?? this.backend).write(index, await this.codec.encode(block));
      this.clean.set(String(index), block);
    }
  }

  /** The named blocks' coefficients, in the order asked for. */
  async read(blocks: number[]): Promise<Float32Array[]> {
    return await Promise.all(blocks.map((index) => this.block(index)));
  }

  /**
   * One block of the tier, as the store holds it rather than a copy: a
   * later patch changes the array handed out, so a reader takes what it
   * needs from it at once and keeps no reference.
   */
  async readBlock(index: number): Promise<Float32Array> {
    return await this.block(index);
  }

  /** One block as it was seeded. The store never changes the array handed out. */
  async readRootBlock(index: number): Promise<Float32Array> {
    if (this.disposed) throw new Error("block store is disposed");
    return await this.rootBlock(index);
  }

  /** The whole packed array, one block at a time, padded as the texture is. */
  async readAll(): Promise<Float32Array> {
    const out = new Float32Array(this.texelCount * 4);
    for (let index = 0; index < this.grid.blockCount; index++) {
      scatterCompactPixelRanges(out, await this.block(index), this.blockRanges(index));
    }
    return out;
  }

  /** The packed state as it was seeded, one block at a time, padded as the texture is. */
  async readAllRoot(): Promise<Float32Array> {
    if (this.disposed) throw new Error("block store is disposed");
    const out = new Float32Array(this.texelCount * 4);
    for (let index = 0; index < this.grid.blockCount; index++) {
      scatterCompactPixelRanges(out, await this.rootBlock(index), this.blockRanges(index));
    }
    return out;
  }

  /** The pixels `ranges` names as they were seeded, laid end to end in range order. */
  async readRootRanges(ranges: Uint32Array): Promise<Float32Array> {
    if (this.disposed) throw new Error("block store is disposed");
    const out = new Float32Array(pixelRangeCount(ranges) * 4);
    for (const index of blocksForPixelRanges(this.grid, ranges)) {
      copyCompactOverlap(out, ranges, await this.rootBlock(index), this.blockRanges(index));
    }
    return out;
  }

  /**
   * The pixels `ranges` names, laid end to end in range order. The list must
   * be sorted and non-overlapping, as every footprint in the app is.
   */
  async readRanges(ranges: Uint32Array): Promise<Float32Array> {
    const out = new Float32Array(pixelRangeCount(ranges) * 4);
    const blocks = blocksForPixelRanges(this.grid, ranges);
    for (const index of blocks) {
      copyCompactOverlap(out, ranges, await this.block(index), this.blockRanges(index));
    }
    return out;
  }

  /** The magnitudes at the taps `runs` names, two floats per tap in run order. */
  async readTaps(runs: Uint32Array): Promise<Float32Array> {
    const out = new Float32Array(tapCount(runs) * 2);
    for (const index of blocksForPixelRanges(this.grid, tapSpanRanges(runs))) {
      copyTapsFromCompact(out, runs, await this.block(index), this.blockRanges(index));
    }
    return out;
  }

  /**
   * Writes values laid out in `ranges` order back into the blocks they fall
   * in, which stay in RAM until the next flush. When the dirty blocks grow
   * past the resident budget, the patch flushes them itself, so unflushed
   * paint cannot hold a whole file decoded.
   */
  async patch(ranges: Uint32Array, values: Float32Array): Promise<void> {
    const blocks = blocksForPixelRanges(this.grid, ranges);
    for (const index of blocks) {
      const block = await this.block(index);
      copyCompactOverlap(block, this.blockRanges(index), values, ranges);
      this.markDirty(index, block);
    }
    if (this.residentBytes > this.maxResidentBytes) await this.flush();
  }

  /**
   * Adds the turns' offsets to the phases of the blocks' pixels in place —
   * the same float arithmetic the addon and the GPU use — and returns the
   * residuals an inverted apply needs: for each float the shift cannot
   * subtract back exactly, its file-absolute index and its original bits, in
   * the order the whole-array walk finds them. Changed blocks stay dirty
   * until the next flush; past the resident budget they flush themselves.
   */
  async applyTurnsCollecting(turns: PhaseTurns): Promise<Uint32Array> {
    const residuals: number[] = [];
    for (let i = 0; i < turns.pixelStarts.length; i++) {
      const spanStart = turns.pixelStarts[i];
      const spanEnd = spanStart + turns.pixelCounts[i];
      const span = Uint32Array.of(spanStart, turns.pixelCounts[i]);
      for (let ch = 0; ch < 2; ch++) {
        const c = turns.offsets[i * 2 + ch];
        if (c === 0) continue;
        for (const index of blocksForPixelRanges(this.grid, span)) {
          const block = await this.block(index);
          const bits = new Uint32Array(block.buffer, block.byteOffset, block.length);
          const ranges = this.blockRanges(index);
          let at = 0;
          for (let r = 0; r + 1 < ranges.length; r += 2) {
            const start = ranges[r];
            const count = ranges[r + 1];
            const lo = Math.max(spanStart, start);
            const hi = Math.min(spanEnd, start + count);
            for (let p = lo; p < hi; p++) {
              const j = (at + (p - start)) * 4 + ch * 2 + 1;
              const before = block[j];
              const after = Math.fround(before + c);
              if (Math.fround(after - c) !== before) residuals.push(p * 4 + ch * 2 + 1, bits[j]);
              block[j] = after;
            }
            at += count;
          }
          this.markDirty(index, block);
          if (this.residentBytes > this.maxResidentBytes) await this.flush();
        }
      }
    }
    return Uint32Array.from(residuals);
  }

  private markDirty(index: number, block: Float32Array): void {
    this.everPatched.add(index);
    this.clean.delete(String(index));
    this.dirty.set(index, block);
    this.dirtyVersion.set(index, (this.dirtyVersion.get(index) ?? 0) + 1);
  }

  /**
   * Encodes and writes every block changed since the last call, one at a
   * time. Each block is encoded from a copy, so a patch landing mid-encode
   * cannot reach the bytes in flight; the version check keeps such a block
   * dirty for the next flush. Calls run one after another, and `dispose`
   * waits for the one in flight.
   */
  async flush(): Promise<void> {
    const run = this.flushing.then(() => this.flushNow());
    this.flushing = run.catch(() => undefined);
    return await run;
  }

  private async flushNow(): Promise<void> {
    for (const [index, block] of [...this.dirty]) {
      if (this.disposed) return;
      const version = this.dirtyVersion.get(index);
      await (this.overlay ?? this.backend).write(index, await this.codec.encode(block.slice()));
      if (this.dirtyVersion.get(index) !== version) continue;
      this.dirty.delete(index);
      this.dirtyVersion.delete(index);
      this.clean.set(String(index), block);
    }
  }

  /** Drops everything, on disk and in RAM. The store cannot be read after this. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.flushing.catch(() => undefined);
    this.dirty.clear();
    this.dirtyVersion.clear();
    this.clean.clear();
    this.root.clear();
    this.everPatched.clear();
    this.overlayOnDisk.clear();
    this.inflight.clear();
    await this.overlay?.clear();
    await this.backend.clear();
  }

  /**
   * One block as it was seeded. A block no patch has reached is a copy of
   * its resident state, taken while nothing can have changed it; one a patch
   * reached is decoded from the seeded bytes. Either copy is kept for the
   * next read.
   */
  private async rootBlock(index: number): Promise<Float32Array> {
    const kept = this.root.get(String(index));
    if (kept) return kept;
    if (!this.everPatched.has(index) && !(await this.overlayHeld(index))) {
      const block = await this.block(index);
      if (!this.everPatched.has(index)) {
        const copy = block.slice();
        this.root.set(String(index), copy);
        return copy;
      }
    }
    const bytes = await this.backend.read(index);
    if (!bytes) throw new Error(`block ${index} was never written`);
    const block = this.checked(index, await this.codec.decode(bytes, this.decodedBytes(index)));
    this.root.set(String(index), block);
    return block;
  }

  /** True when the overlay held the block before this session patched anything. */
  private async overlayHeld(index: number): Promise<boolean> {
    if (!this.overlay) return false;
    const known = this.overlayOnDisk.get(index);
    if (known !== undefined) return known;
    const held = this.overlay.has ? await this.overlay.has(index) : (await this.overlay.read(index)) !== null;
    this.overlayOnDisk.set(index, held);
    return held;
  }

  /** The bytes a block holds once decoded. */
  private decodedBytes(index: number): number {
    return pixelRangeCount(this.blockRanges(index)) * 16;
  }

  /**
   * One block's coefficients, decoding it from the backend when it is not
   * resident. A dirty block is the only truth for its pixels — the backend
   * still holds the state before the patch — so it is answered from RAM.
   */
  private async block(index: number): Promise<Float32Array> {
    if (this.disposed) throw new Error("block store is disposed");
    const dirty = this.dirty.get(index);
    if (dirty) return dirty;
    const clean = this.clean.get(String(index));
    if (clean) return clean;

    const running = this.inflight.get(index);
    if (running) return await running;

    const load = this.load(index);
    this.inflight.set(index, load);
    try {
      return await load;
    } finally {
      this.inflight.delete(index);
    }
  }

  private async load(index: number): Promise<Float32Array> {
    const bytes = (await this.overlay?.read(index)) ?? (await this.backend.read(index));
    if (!bytes) throw new Error(`block ${index} was never written`);
    const block = this.checked(index, await this.codec.decode(bytes, this.decodedBytes(index)));
    this.clean.set(String(index), block);
    return block;
  }

  /** Refuses a block whose size does not fit this store's grid, so blocks cut for another grid can never be misread as this one's. */
  private checked(index: number, block: Float32Array): Float32Array {
    const expected = pixelRangeCount(this.blockRanges(index)) * 4;
    if (block.length !== expected) {
      throw new Error(`block ${index} holds ${block.length} floats, expected ${expected}`);
    }
    return block;
  }
}

/** A store's blocks as one file each, under the user data directory. */
export function fileBlockBackend(directory: string): BlockBackend {
  const pathOf = (index: number): string => host.path.join(directory, `${index}.blk`);
  let made = false;
  const ensure = async (): Promise<void> => {
    if (made) return;
    await host.fs.mkdir(directory, { recursive: true });
    made = true;
  };
  return {
    async read(index) {
      try {
        const buf = await host.fs.readFile(pathOf(index));
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch {
        return null;
      }
    },
    async has(index) {
      try {
        await host.fs.access(pathOf(index));
        return true;
      } catch {
        return false;
      }
    },
    async write(index, bytes) {
      await ensure();
      await host.fs.writeFile(pathOf(index), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
    async clear() {
      made = false;
      await host.fs.rm(directory, { recursive: true, force: true });
    },
  };
}
