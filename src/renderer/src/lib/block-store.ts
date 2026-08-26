import { layoutTexels } from "./band-layout";
import { blockPixelRanges, blocksForPixelRanges, type BlockGrid } from "./block-grid";
import { ByteBudgetCache } from "./byte-budget-cache";
import { host } from "./host";
import { copyCompactOverlap, gatherPixelRanges, pixelRangeCount, scatterCompactPixelRanges } from "./pixel-ranges";

/** Where a store keeps its encoded blocks between reads. */
export interface BlockBackend {
  read(index: number): Promise<Uint8Array | null>;
  write(index: number, bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

/** How a block's coefficients turn into stored bytes and back. */
export interface BlockCodec {
  encode(block: Float32Array): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<Float32Array>;
}

/** The addon's plane reorder plus zstd, both off the JS thread. */
export const packedBlockCodec: BlockCodec = {
  async encode(block) {
    const blob = await host.analysis.encodeHistorySnapshot(block);
    return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  },
  async decode(bytes) {
    return await host.analysis.decodeHistorySnapshot(bytes);
  },
};

/** Decoded blocks held in RAM at once, before the oldest clean one is dropped. */
export const DEFAULT_RESIDENT_BYTES = 64 * 1024 * 1024;

/** What a store keeps beyond its grid and its backend. */
export type BlockStoreOptions = {
  codec?: BlockCodec;
  maxResidentBytes?: number;
  /**
   * Texels a whole packed array holds, padding included. `readAll` returns an
   * array of this size, so it drops straight into the readers that upload it
   * as a texture. Defaults to the coefficients alone.
   */
  texelCount?: number;
};

/**
 * The packed coefficients of one file, held as blocks on disk with a bounded
 * set decoded in RAM. Readers ask for the pixels they need; only the blocks
 * those pixels fall in are decoded, so a longer file costs reads rather than
 * memory.
 */
export class BlockStore {
  readonly grid: BlockGrid;
  private readonly backend: BlockBackend;
  private readonly codec: BlockCodec;
  private readonly clean: ByteBudgetCache<Float32Array>;
  private readonly dirty = new Map<number, Float32Array>();
  private readonly dirtyVersion = new Map<number, number>();
  private readonly inflight = new Map<number, Promise<Float32Array>>();
  private readonly ranges: Array<Uint32Array | undefined>;
  private readonly texelCount: number;
  private disposed = false;

  constructor(grid: BlockGrid, backend: BlockBackend, options: BlockStoreOptions = {}) {
    this.grid = grid;
    this.backend = backend;
    this.codec = options.codec ?? packedBlockCodec;
    this.texelCount = Math.max(options.texelCount ?? 0, layoutTexels(grid.layout));
    this.clean = new ByteBudgetCache<Float32Array>(
      options.maxResidentBytes ?? DEFAULT_RESIDENT_BYTES,
      (block) => block.byteLength,
    );
    this.ranges = new Array<Uint32Array | undefined>(grid.blockCount);
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
   * goes so no more than one block's bytes are held beyond the cache.
   */
  async seed(packed: Float32Array): Promise<void> {
    for (let index = 0; index < this.grid.blockCount; index++) {
      const block = gatherPixelRanges(packed, this.blockRanges(index));
      await this.backend.write(index, await this.codec.encode(block));
      this.clean.set(String(index), block);
    }
  }

  /** The named blocks' coefficients, in the order asked for. */
  async read(blocks: number[]): Promise<Float32Array[]> {
    return await Promise.all(blocks.map((index) => this.block(index)));
  }

  /** The whole packed array, one block at a time, padded as the texture is. */
  async readAll(): Promise<Float32Array> {
    const out = new Float32Array(this.texelCount * 4);
    for (let index = 0; index < this.grid.blockCount; index++) {
      scatterCompactPixelRanges(out, await this.block(index), this.blockRanges(index));
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

  /**
   * Writes values laid out in `ranges` order back into the blocks they fall
   * in, which stay in RAM until the next flush.
   */
  async patch(ranges: Uint32Array, values: Float32Array): Promise<void> {
    const blocks = blocksForPixelRanges(this.grid, ranges);
    for (const index of blocks) {
      const block = await this.block(index);
      copyCompactOverlap(block, this.blockRanges(index), values, ranges);
      this.clean.delete(String(index));
      this.dirty.set(index, block);
      this.dirtyVersion.set(index, (this.dirtyVersion.get(index) ?? 0) + 1);
    }
  }

  /**
   * Encodes and writes every block changed since the last call. A block stays
   * dirty while it is being written, so a patch arriving meanwhile lands on
   * the same array; the bytes just written do not hold that patch, so the
   * block stays dirty for the next flush.
   */
  async flush(): Promise<void> {
    for (const [index, block] of [...this.dirty]) {
      const version = this.dirtyVersion.get(index);
      await this.backend.write(index, await this.codec.encode(block));
      if (this.dirtyVersion.get(index) !== version) continue;
      this.dirty.delete(index);
      this.dirtyVersion.delete(index);
      this.clean.set(String(index), block);
    }
  }

  /** Drops everything, on disk and in RAM. The store cannot be read after this. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.dirty.clear();
    this.dirtyVersion.clear();
    this.clean.clear();
    this.inflight.clear();
    await this.backend.clear();
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
    const bytes = await this.backend.read(index);
    if (!bytes) throw new Error(`block ${index} was never written`);
    const block = await this.codec.decode(bytes);
    this.clean.set(String(index), block);
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
