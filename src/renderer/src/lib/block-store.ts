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
import { yieldIfLong } from "./frame-yield";

// Blocks a read or write over many blocks keeps in flight at once.
const READ_ALL_AHEAD = 8;
// Blocks a flush encodes at once. A flush runs behind the work that waits on
// it, so it keeps to part of the thread pool and leaves the rest to a commit.
const FLUSH_AHEAD = 4;

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
  /**
   * Copies the pixels two compact range lists share off the JS thread; a
   * large range read copies each block through it. Defaults to the host's.
   */
  copyRanges?: PixelRangeCopy;
  /** Pixels past which a range read copies off the JS thread. */
  offThreadReadPixels?: number;
};

/** An off-thread copyCompactOverlap: neither array may change until it resolves. */
export type PixelRangeCopy = (
  dest: Float32Array,
  destRanges: Uint32Array,
  src: Float32Array,
  srcRanges: Uint32Array,
) => Promise<void>;

const OFF_THREAD_READ_PIXELS = 1 << 20;

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
  /**
   * Holds a background flush between its batches until the returned release
   * is called, so work that waits on the machine is not slowed by it. A flush
   * a patch waits on is never held.
   */
  pauseFlush(): () => void;
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
  private readonly copyRanges: PixelRangeCopy | undefined;
  private readonly offThreadReadPixels: number;
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
  /**
   * Counts every write of a block's coefficients. A load caches what it read
   * only when no write landed while it read, so a read of the old bytes that
   * finishes after a reseed or a patch can never put them back.
   */
  private readonly writes = new Map<number, number>();
  /** Reseed writes not yet on disk, by block. A load waits for one before it reads. */
  private readonly unsettled = new Map<number, Promise<void>>();
  // Arrays a flush is encoding or a read is copying off the JS thread, with
  // how many are. A patch copies such a block before writing.
  private readonly pinned = new Map<Float32Array, number>();
  private readonly inflight = new Map<number, Promise<Float32Array>>();
  private readonly ranges: Array<Uint32Array | undefined>;
  private readonly texelCount: number;
  private readonly maxResidentBytes: number;
  private flushing: Promise<void> = Promise.resolve();
  private flushQueued = false;
  private flushPauses = 0;
  // Flushes a patch waits on; while one is queued, a held flush carries on.
  private urgentFlushes = 0;
  private readonly flushResumes: Array<() => void> = [];
  private disposed = false;
  private seeded = false;

  constructor(grid: BlockGrid, backend: BlockBackend, options: BlockStoreOptions = {}) {
    this.grid = grid;
    this.backend = backend;
    this.overlay = options.overlay ?? null;
    this.codec = options.codec ?? packedBlockCodec;
    this.copyRanges = options.copyRanges ?? host.analysis?.copyPixelRanges;
    this.offThreadReadPixels = options.offThreadReadPixels ?? OFF_THREAD_READ_PIXELS;
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

  /** Bytes in decoded current and original blocks, each cache counted once. */
  get residentBytes(): number {
    return this.currentResidentBytes + this.root.byteCount;
  }

  /** The current tier's flush budget excludes the independently bounded original cache. */
  private get currentResidentBytes(): number {
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
      writing = this.settling(index, async () => this.backend.write(index, await this.codec.encode(block)));
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
    const store = this.overlay ?? this.backend;
    const seed = async (index: number): Promise<void> => {
      const block = gatherPixelRanges(packed, this.blockRanges(index));
      this.everPatched.add(index);
      await this.settling(index, async () => store.write(index, await this.codec.encode(block)));
      this.clean.set(String(index), block);
    };
    // A few blocks encode and write at once; each is its own record.
    for (let start = 0; start < this.grid.blockCount; start += READ_ALL_AHEAD) {
      const batch: Promise<void>[] = [];
      for (let index = start; index < Math.min(start + READ_ALL_AHEAD, this.grid.blockCount); index++) {
        batch.push(seed(index));
      }
      await Promise.all(batch);
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
    await this.eachBlock((index, values) => scatterCompactPixelRanges(out, values, this.blockRanges(index)));
    return out;
  }

  /** Hands every block's current values to `take`, in index order. */
  private async eachBlock(take: (index: number, values: Float32Array) => void): Promise<void> {
    await this.walk(
      Array.from({ length: this.grid.blockCount }, (_, index) => index),
      this.current,
      take,
    );
  }

  /**
   * Hands each of `indices` — no index twice — to `take` in order, with a few
   * loads in flight ahead of the block being taken. A walk over more than the
   * resident budget caches only what fits without evicting. A current block a
   * patch reached while its load was in flight is taken as patched.
   */
  private async walk(
    indices: readonly number[],
    load: (index: number, sweep: boolean) => Promise<Float32Array>,
    take: (index: number, values: Float32Array) => void | Promise<void>,
  ): Promise<void> {
    let bytes = 0;
    for (const index of indices) bytes += this.decodedBytes(index);
    const sweep = bytes > this.maxResidentBytes;
    const pending: Promise<Float32Array>[] = [];
    // A read ahead of the walk is dropped where the walk stops early — a store
    // disposed under it — so each carries its own handler and the one that is
    // waited on still throws.
    const readAhead = (at: number): void => {
      if (at >= indices.length) return;
      const values = load(indices[at], sweep);
      void values.catch(() => {});
      pending.push(values);
    };
    for (let at = 0; at < READ_ALL_AHEAD; at++) readAhead(at);
    for (let at = 0; at < indices.length; at++) {
      const loaded = await pending.shift()!;
      readAhead(at + READ_ALL_AHEAD);
      await take(indices[at], (load === this.current ? this.dirty.get(indices[at]) : undefined) ?? loaded);
    }
  }

  /** The packed state as it was seeded, one block at a time, padded as the texture is. */
  async readAllRoot(): Promise<Float32Array> {
    if (this.disposed) throw new Error("block store is disposed");
    const out = new Float32Array(this.texelCount * 4);
    await this.walk(
      Array.from({ length: this.grid.blockCount }, (_, index) => index),
      (index, sweep) => this.rootBlock(index, sweep),
      (index, values) => scatterCompactPixelRanges(out, values, this.blockRanges(index)),
    );
    return out;
  }

  /** The pixels `ranges` names as they were seeded, laid end to end in range order. */
  async readRootRanges(ranges: Uint32Array): Promise<Float32Array> {
    if (this.disposed) throw new Error("block store is disposed");
    return await this.gather(ranges, (index, sweep) => this.rootBlock(index, sweep));
  }

  /**
   * The pixels `ranges` names, laid end to end in range order. The list must
   * be sorted and non-overlapping, as every footprint in the app is.
   */
  async readRanges(ranges: Uint32Array): Promise<Float32Array> {
    return await this.gather(ranges, this.current);
  }

  /**
   * The pixels `ranges` names from the blocks `load` gives, in range order. A
   * large read copies each block off the JS thread as it arrives, the blocks
   * side by side.
   */
  private async gather(
    ranges: Uint32Array,
    load: (index: number, sweep: boolean) => Promise<Float32Array>,
  ): Promise<Float32Array> {
    const out = new Float32Array(pixelRangeCount(ranges) * 4);
    const copy = pixelRangeCount(ranges) > this.offThreadReadPixels ? this.copyRanges : undefined;
    const copies: Promise<void>[] = [];
    let since = performance.now();
    try {
      await this.walk(blocksForPixelRanges(this.grid, ranges), load, async (index, values) => {
        if (copy) {
          copies.push(this.whilePinned(values, () => copy(out, ranges, values, this.blockRanges(index))));
          return;
        }
        copyCompactOverlap(out, ranges, values, this.blockRanges(index));
        since = await yieldIfLong(since);
      });
    } finally {
      await Promise.allSettled(copies);
    }
    await Promise.all(copies);
    return out;
  }

  /** Runs `work` with `block` pinned, so a patch meanwhile writes to a copy of it. */
  private async whilePinned<T>(block: Float32Array, work: () => Promise<T>): Promise<T> {
    this.pinned.set(block, (this.pinned.get(block) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (this.pinned.get(block) ?? 1) - 1;
      if (left > 0) this.pinned.set(block, left);
      else this.pinned.delete(block);
    }
  }

  /** The magnitudes at the taps `runs` names, two floats per tap in run order. */
  async readTaps(runs: Uint32Array): Promise<Float32Array> {
    const out = new Float32Array(tapCount(runs) * 2);
    await this.walk(blocksForPixelRanges(this.grid, tapSpanRanges(runs)), this.current, (index, values) =>
      copyTapsFromCompact(out, runs, values, this.blockRanges(index)),
    );
    return out;
  }

  /**
   * Writes values laid out in `ranges` order back into the blocks they fall
   * in, which stay in RAM until the next flush. Past the resident budget the
   * patch starts a flush, and past twice it waits for one, so unflushed paint
   * cannot hold a whole file decoded.
   */
  async patch(ranges: Uint32Array, values: Float32Array): Promise<void> {
    await this.walk(blocksForPixelRanges(this.grid, ranges), this.current, async (index, held) => {
      const block = this.writable(held);
      copyCompactOverlap(block, this.blockRanges(index), values, ranges);
      this.markDirty(index, block);
      await this.flushIfOver();
    });
  }

  /**
   * Adds the turns' offsets to the phases of the blocks' pixels in place —
   * the same float arithmetic the addon and the GPU use — and returns the
   * residuals an inverted apply needs: for each float the shift cannot
   * subtract back exactly, its file-absolute index and its original bits, in
   * the order the whole-array walk finds them. Changed blocks stay dirty
   * until the next flush, and flush as a patch's do.
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
        await this.walk(blocksForPixelRanges(this.grid, span), this.current, async (index, held) => {
          const block = this.writable(held);
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
          await this.flushIfOver();
        });
      }
    }
    return Uint32Array.from(residuals);
  }

  /**
   * Starts a flush once the changed blocks pass the resident budget, and waits
   * for one only past twice it. A block leaves the clean cache as it turns
   * dirty, so between the two the store holds little more than the budget.
   */
  private async flushIfOver(): Promise<void> {
    const bytes = this.currentResidentBytes;
    if (bytes > 2 * this.maxResidentBytes) await this.flush(false);
    else if (bytes > this.maxResidentBytes && !this.flushQueued) {
      this.flushQueued = true;
      void this.flush()
        .catch((error: unknown) => console.error("block store: background flush failed", error))
        .finally(() => {
          this.flushQueued = false;
        });
    }
  }

  /** The block itself, or a copy of it while a flush or a read holds it. */
  private writable(block: Float32Array): Float32Array {
    return this.pinned.has(block) ? block.slice() : block;
  }

  private wrote(index: number): void {
    this.writes.set(index, (this.writes.get(index) ?? 0) + 1);
  }

  /** Runs one reseed write of block `index`, which loads of the block wait for. */
  private async settling(index: number, write: () => Promise<void>): Promise<void> {
    this.wrote(index);
    const done = write();
    const settled = done.then(
      () => undefined,
      () => undefined,
    );
    this.unsettled.set(index, settled);
    try {
      await done;
    } finally {
      if (this.unsettled.get(index) === settled) this.unsettled.delete(index);
    }
  }

  private markDirty(index: number, block: Float32Array): void {
    this.wrote(index);
    this.everPatched.add(index);
    this.clean.delete(String(index));
    this.dirty.set(index, block);
    this.dirtyVersion.set(index, (this.dirtyVersion.get(index) ?? 0) + 1);
  }

  /**
   * Encodes and writes every block changed since the last call, a few at a
   * time. A patch landing mid-encode writes to a copy of the block, so it
   * cannot reach the bytes in flight; the version check keeps the copy dirty
   * for the next flush. Calls run one after another, and `dispose`
   * waits for the one in flight.
   */
  async flush(pausable = true): Promise<void> {
    if (!pausable) {
      this.urgentFlushes++;
      for (const resume of this.flushResumes.splice(0)) resume();
    }
    const run = this.flushing.then(() => this.flushNow(pausable));
    this.flushing = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      if (!pausable) this.urgentFlushes--;
    }
  }

  pauseFlush(): () => void {
    this.flushPauses++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.flushPauses--;
      if (this.flushPauses === 0) for (const resume of this.flushResumes.splice(0)) resume();
    };
  }

  private async flushNow(pausable: boolean): Promise<void> {
    const flushOne = async (index: number, block: Float32Array): Promise<void> => {
      if (this.disposed) return;
      const version = this.dirtyVersion.get(index);
      const bytes = await this.whilePinned(block, () => this.codec.encode(block));
      if (this.disposed) return;
      await (this.overlay ?? this.backend).write(index, bytes);
      if (this.dirtyVersion.get(index) !== version) return;
      this.dirty.delete(index);
      this.dirtyVersion.delete(index);
      this.clean.set(String(index), block);
    };
    // A few blocks encode and write at once; each is its own record.
    const dirty = [...this.dirty];
    for (let start = 0; start < dirty.length; start += FLUSH_AHEAD) {
      while (pausable && this.flushPauses > 0 && this.urgentFlushes === 0 && !this.disposed) {
        await new Promise<void>((resume) => this.flushResumes.push(resume));
      }
      await Promise.all(dirty.slice(start, start + FLUSH_AHEAD).map(([index, block]) => flushOne(index, block)));
    }
  }

  /** Drops everything, on disk and in RAM. The store cannot be read after this. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const resume of this.flushResumes.splice(0)) resume();
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
  private async rootBlock(index: number, sweep = false): Promise<Float32Array> {
    const kept = this.root.get(String(index));
    if (kept) return kept;
    const keep = (block: Float32Array): void =>
      sweep ? this.root.setIfRoom(String(index), block) : this.root.set(String(index), block);
    if (!this.everPatched.has(index) && !(await this.overlayHeld(index))) {
      const block = await this.block(index, sweep);
      if (!this.everPatched.has(index)) {
        const copy = block.slice();
        keep(copy);
        return copy;
      }
    }
    const bytes = await this.backend.read(index);
    if (!bytes) throw new Error(`block ${index} was never written`);
    const block = this.checked(index, await this.codec.decode(bytes, this.decodedBytes(index)));
    keep(block);
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
  /** One block of the current tier, loaded for a walk. */
  private readonly current = (index: number, sweep: boolean): Promise<Float32Array> => this.block(index, sweep);

  /** The block as the store holds it in memory, unflushed or clean, or null when it must come from disk. */
  private held(index: number): Float32Array | null {
    return this.dirty.get(index) ?? this.clean.get(String(index)) ?? null;
  }

  private async block(index: number, sweep = false): Promise<Float32Array> {
    if (this.disposed) throw new Error("block store is disposed");
    const held = this.held(index);
    if (held) return held;

    const running = this.inflight.get(index);
    if (running) return await running;

    const load = this.load(index, sweep);
    this.inflight.set(index, load);
    try {
      return await load;
    } finally {
      this.inflight.delete(index);
    }
  }

  private async load(index: number, sweep: boolean): Promise<Float32Array> {
    for (;;) {
      const settling = this.unsettled.get(index);
      if (settling) {
        await settling;
        const held = this.held(index);
        if (held) return held;
        continue;
      }
      const written = this.writes.get(index);
      const bytes = (await this.overlay?.read(index)) ?? (await this.backend.read(index));
      if (!bytes) throw new Error(`block ${index} was never written`);
      const block = this.checked(index, await this.codec.decode(bytes, this.decodedBytes(index)));
      // A write began while the block was read, so these bytes may be the old ones.
      if (this.writes.get(index) !== written) {
        const held = this.held(index);
        if (held) return held;
        continue;
      }
      if (sweep) this.clean.setIfRoom(String(index), block);
      else this.clean.set(String(index), block);
      return block;
    }
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
