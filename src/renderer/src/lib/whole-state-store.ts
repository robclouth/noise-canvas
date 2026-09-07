import { applyPhaseTurnsCollecting } from "../../../main/lib/history-delta";
import type { PhaseTurns } from "../../../main/lib/types";
import { layoutTexels } from "./band-layout";
import { blockPixelRanges, blocksForPixelRanges, type BlockGrid } from "./block-grid";
import {
  DEFAULT_RESIDENT_BYTES,
  packedBlockCodec,
  type BlockBackend,
  type BlockCodec,
  type PackedStateStore,
} from "./block-store";
import { ByteBudgetCache } from "./byte-budget-cache";
import {
  copyCompactOverlap,
  gatherPixelRanges,
  gatherTaps,
  pixelRangeCount,
  scatterCompactPixelRanges,
} from "./pixel-ranges";

/** What a whole-state store keeps beyond its grid and its backend. */
export type WholeStateStoreOptions = {
  codec?: BlockCodec;
  /** Budget for the seeded blocks decoded back from the backend. */
  maxResidentBytes?: number;
  /** Texels a whole packed array holds, padding included. Defaults to the coefficients alone. */
  texelCount?: number;
};

/**
 * The packed state of a file the canvas holds whole. The tier is one array
 * in RAM, patched in place, so a stroke never encodes or writes anything.
 * The seeded state goes to the backend as blocks behind the seed, and the
 * tier answers for it until the first patch, which waits for that write.
 */
export class WholeStateStore implements PackedStateStore {
  readonly grid: BlockGrid;
  readonly tierOnDisk = false;
  private readonly backend: BlockBackend;
  private readonly codec: BlockCodec;
  private readonly texelCount: number;
  private readonly root: ByteBudgetCache<Float32Array>;
  private readonly ranges: Array<Uint32Array | undefined>;
  private current: Float32Array | null = null;
  // True from a seed until the first patch, while the tier is the seeded state.
  private tierIsRoot = false;
  private writing: Promise<void> = Promise.resolve();
  private settled: Promise<void> = Promise.resolve();
  private writeRun = 0;
  private disposed = false;
  private seeded = false;

  constructor(grid: BlockGrid, backend: BlockBackend, options: WholeStateStoreOptions = {}) {
    this.grid = grid;
    this.backend = backend;
    this.codec = options.codec ?? packedBlockCodec;
    this.texelCount = Math.max(options.texelCount ?? 0, layoutTexels(grid.layout));
    const budget = options.maxResidentBytes ?? DEFAULT_RESIDENT_BYTES;
    this.root = new ByteBudgetCache<Float32Array>(Math.floor(budget / 2), (block) => block.byteLength);
    this.ranges = new Array<Uint32Array | undefined>(grid.blockCount);
  }

  get isSeeded(): boolean {
    return this.seeded;
  }

  /** Bytes the tier and the decoded seeded blocks hold. */
  get residentBytes(): number {
    return (this.current?.byteLength ?? 0) + this.root.byteCount;
  }

  /** Nothing waits for a flush: the tier has no disk copy. */
  get dirtyCount(): number {
    return 0;
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

  /** Takes the whole packed state as the tier and the seeded state, replacing whatever the store held. */
  async seed(packed: Float32Array): Promise<void> {
    await this.seedFrom((index) => Promise.resolve(gatherPixelRanges(packed, this.blockRanges(index))));
  }

  /**
   * Builds the tier from `source` a block at a time and takes it as the
   * seeded state, replacing whatever the store held. The seeded blocks are
   * written to the backend behind the call; `flush` waits for them.
   */
  async seedFrom(source: (index: number) => Promise<Float32Array>): Promise<void> {
    if (this.disposed) throw new Error("whole state store is disposed");
    this.writeRun++;
    await this.settled;
    this.root.clear();
    await this.backend.clear();
    const current = new Float32Array(this.texelCount * 4);
    for (let index = 0; index < this.grid.blockCount; index++) {
      const block = this.checked(index, await source(index));
      scatterCompactPixelRanges(current, block, this.blockRanges(index));
    }
    if (this.disposed) throw new Error("whole state store is disposed");
    this.current = current;
    this.tierIsRoot = true;
    this.seeded = true;
    this.writeRoot(current);
  }

  /** Replaces the tier with the whole packed state. The seeded state stays as it is. */
  async seedCurrent(packed: Float32Array): Promise<void> {
    if (this.disposed) throw new Error("whole state store is disposed");
    await this.settled;
    const floats = this.texelCount * 4;
    if (packed.length < layoutTexels(this.grid.layout) * 4) {
      throw new Error(`the packed state holds ${packed.length} floats, expected at least ${floats}`);
    }
    const current = new Float32Array(floats);
    current.set(packed.subarray(0, Math.min(packed.length, floats)));
    this.current = current;
    this.tierIsRoot = false;
  }

  async readBlock(index: number): Promise<Float32Array> {
    return gatherPixelRanges(this.tier(), this.blockRanges(index));
  }

  async readRootBlock(index: number): Promise<Float32Array> {
    if (this.tierIsRoot) return gatherPixelRanges(this.tier(), this.blockRanges(index));
    return await this.rootBlock(index);
  }

  /** A copy of the tier, padded as the texture is. */
  async readAll(): Promise<Float32Array> {
    return this.tier().slice();
  }

  /** The packed state as it was seeded, padded as the texture is. */
  async readAllRoot(): Promise<Float32Array> {
    if (this.tierIsRoot) return this.tier().slice();
    if (this.disposed) throw new Error("whole state store is disposed");
    const out = new Float32Array(this.texelCount * 4);
    for (let index = 0; index < this.grid.blockCount; index++) {
      scatterCompactPixelRanges(out, await this.rootBlock(index), this.blockRanges(index));
    }
    return out;
  }

  /** The pixels `ranges` names, laid end to end in range order. */
  async readRanges(ranges: Uint32Array): Promise<Float32Array> {
    return gatherPixelRanges(this.tier(), ranges);
  }

  /** The magnitudes at the taps `runs` names, two floats per tap in run order. */
  async readTaps(runs: Uint32Array): Promise<Float32Array> {
    return gatherTaps(this.tier(), runs);
  }

  /** The pixels `ranges` names as they were seeded, laid end to end in range order. */
  async readRootRanges(ranges: Uint32Array): Promise<Float32Array> {
    if (this.tierIsRoot) return gatherPixelRanges(this.tier(), ranges);
    if (this.disposed) throw new Error("whole state store is disposed");
    const out = new Float32Array(pixelRangeCount(ranges) * 4);
    for (const index of blocksForPixelRanges(this.grid, ranges)) {
      copyCompactOverlap(out, ranges, await this.rootBlock(index), this.blockRanges(index));
    }
    return out;
  }

  /** Writes values laid out in `ranges` order into the tier. */
  async patch(ranges: Uint32Array, values: Float32Array): Promise<void> {
    scatterCompactPixelRanges(await this.tierForWrite(), values, ranges);
  }

  /**
   * Adds the turns' offsets to the tier's phases in place and returns the
   * residuals an inverted apply needs, exactly as the block store does.
   */
  async applyTurnsCollecting(turns: PhaseTurns): Promise<Uint32Array> {
    return applyPhaseTurnsCollecting(await this.tierForWrite(), turns);
  }

  /** Resolves once the seeded blocks are written. */
  flush(): Promise<void> {
    return this.writing;
  }

  /** Drops everything, on disk and in RAM. The store cannot be read after this. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.writeRun++;
    await this.settled;
    this.current = null;
    this.root.clear();
    await this.backend.clear();
  }

  private tier(): Float32Array {
    if (this.disposed) throw new Error("whole state store is disposed");
    if (!this.current) throw new Error("whole state store holds no tier");
    return this.current;
  }

  /** The tier once the seeded state no longer depends on it. */
  private async tierForWrite(): Promise<Float32Array> {
    await this.settled;
    const tier = this.tier();
    this.tierIsRoot = false;
    return tier;
  }

  /** Encodes and writes the seeded blocks one at a time, taking each from `current` as it goes. */
  private writeRoot(current: Float32Array): void {
    const run = ++this.writeRun;
    const write = (async () => {
      for (let index = 0; index < this.grid.blockCount; index++) {
        if (this.disposed || this.writeRun !== run) return;
        const bytes = await this.codec.encode(gatherPixelRanges(current, this.blockRanges(index)));
        if (this.disposed || this.writeRun !== run) return;
        await this.backend.write(index, bytes);
      }
    })();
    this.writing = write;
    this.settled = write.catch(() => undefined);
  }

  /** One seeded block, decoded from the backend and kept for the next read. */
  private async rootBlock(index: number): Promise<Float32Array> {
    await this.settled;
    const kept = this.root.get(String(index));
    if (kept) return kept;
    const bytes = await this.backend.read(index);
    if (!bytes) throw new Error(`block ${index} was never written`);
    const expected = pixelRangeCount(this.blockRanges(index));
    const block = this.checked(index, await this.codec.decode(bytes, expected * 16));
    this.root.set(String(index), block);
    return block;
  }

  /** Refuses a block whose size does not fit this store's grid. */
  private checked(index: number, block: Float32Array): Float32Array {
    const expected = pixelRangeCount(this.blockRanges(index)) * 4;
    if (block.length !== expected) {
      throw new Error(`block ${index} holds ${block.length} floats, expected ${expected}`);
    }
    return block;
  }
}
