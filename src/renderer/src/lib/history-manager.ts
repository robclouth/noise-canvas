import { Vector2 } from "three";
import { useStore } from "@renderer/store";
import { openFiles } from "@renderer/store/files";
import type { SpectrogramData } from "@renderer/store/types";
import { isManagedFilePath } from "@renderer/store/managed-path";
import { host } from "./host";
import { ipcSend } from "./ipc";

const MANIFEST_FILENAME = "tree.json";
const CHECKPOINT_INTERVAL = 20;
const AUDIO_LRU_CAPACITY = 50;
const MANIFEST_WRITE_DEBOUNCE_MS = 400;
const PACKED_STATE_CACHE_BYTES = 256 * 1024 * 1024;

export type HistoryNodeKind = "root" | "stroke" | "resize" | "reanalyze" | "checkpoint";

export interface HistoryDimensions {
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numBands: number;
  numChannels: number;
  sampleRate: number;
  minFreq: number;
  bandsPerOctave: number;
  // Optional so manifests written before this field round-trip cleanly; absent
  // means the Convolve effect falls back to no IR normalization for that file.
  magnitudeEnergy?: number;
}

export interface HistoryNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  lastChildId: string | null;
  timestamp: number;
  label: string;
  kind: HistoryNodeKind;
  storage: "delta" | "packed" | "full";
  dimensions: HistoryDimensions;
  synthesisMetadata?: {
    bandOffsets: number[];
    bandStepLog2s: number[];
    bandLengths: number[];
  };
  audioPeak?: number;
  audioCached?: boolean;
  customLabel?: string;
  favorited?: boolean;
}

const HISTORY_MANIFEST_VERSION = 3;

interface HistoryManifest {
  version: typeof HISTORY_MANIFEST_VERSION;
  rootId: string;
  currentId: string;
  // History node whose audio is currently persisted to disk. The file is dirty
  // exactly when currentId differs from it. Absent on legacy manifests and on
  // never-saved files; both fall back to the root snapshot.
  savedNodeId?: string;
  nodes: Record<string, HistoryNode>;
}

// --- Pure codec ---

/**
 * Footprint delta codec. A stroke changes only the pixels under the brush, given
 * as packed-pixel ranges — one contiguous range per frequency band, because the
 * packed texture stores each band's time-series at its own offset, so a single
 * time-window spans many disjoint ranges. The delta holds the after-values for
 * those pixels; reconstruction overwrites the base with them, which is exact (no
 * additive drift — see PackedStateCache).
 *
 * `ranges` is a flat [pixelStart, pixelCount, ...] list; `patch` holds the RGBA
 * values for those pixels concatenated in range order.
 */

// True if any pixel inside the footprint ranges differs between before/after.
export function footprintChanged(before: Float32Array, after: Float32Array, ranges: Uint32Array): boolean {
  for (let r = 0; r < ranges.length; r += 2) {
    const start = ranges[r] * 4;
    const end = start + ranges[r + 1] * 4;
    for (let i = start; i < end; i++) {
      if (before[i] !== after[i]) return true;
    }
  }
  return false;
}

// Reconstruct `after` from `base` by overwriting the footprint ranges with the
// stored values. Lossless: stored values are exact, so repeated round-trips
// never drift.
export function applyFootprintDelta(base: Float32Array, ranges: Uint32Array, patch: Float32Array): Float32Array {
  const out = new Float32Array(base);
  let p = 0;
  for (let r = 0; r < ranges.length; r += 2) {
    const start = ranges[r] * 4;
    const count = ranges[r + 1] * 4;
    out.set(patch.subarray(p, p + count), start);
    p += count;
  }
  return out;
}

// Build the on-disk delta directly from the source FBO buffer. Layout:
// [u32 numRanges][u32 ranges...][f32 patch], packed into one buffer so a single
// zstd blob carries both the ranges and their values. The footprint after-values
// are copied straight from `after` into the patch region in a single pass.
export function encodeFootprintDelta(after: Float32Array, ranges: Uint32Array): Uint8Array {
  let total = 0;
  for (let r = 1; r < ranges.length; r += 2) total += ranges[r] * 4;
  const headerBytes = 4 + ranges.byteLength;
  const buf = new ArrayBuffer(headerBytes + total * 4);
  new DataView(buf).setUint32(0, ranges.length / 2, true);
  new Uint32Array(buf, 4, ranges.length).set(ranges);
  const patch = new Float32Array(buf, headerBytes, total);
  let p = 0;
  for (let r = 0; r < ranges.length; r += 2) {
    const start = ranges[r] * 4;
    const count = ranges[r + 1] * 4;
    patch.set(after.subarray(start, start + count), p);
    p += count;
  }
  return new Uint8Array(buf);
}

export function decodeFootprintDelta(bytes: Uint8Array): { ranges: Uint32Array; patch: Float32Array } {
  // Copy into a fresh 4-byte-aligned buffer so the typed-array views are valid
  // regardless of the decompressed buffer's byte offset.
  const buf = bytes.slice().buffer;
  const numRanges = new DataView(buf).getUint32(0, true);
  const ranges = new Uint32Array(buf, 4, numRanges * 2);
  const patch = new Float32Array(buf, 4 + numRanges * 8);
  return { ranges, patch };
}

/**
 * Bounded LRU of canonical packed FBO states keyed by history node id. Holds the
 * exact arrays that were last on screen so revisiting a node during undo/redo is
 * both instant (no disk read / decompress / delta replay) and lossless — deriving
 * a neighbour by adding/subtracting a stored delta would accumulate float error
 * across repeated round-trips. Capacity is a byte budget so it adapts to texture
 * size; the most-recently used entry is always retained.
 */
export class PackedStateCache {
  private readonly map = new Map<string, Float32Array>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(id: string): Float32Array | undefined {
    const v = this.map.get(id);
    if (v === undefined) return undefined;
    // Refresh recency: delete + re-insert moves it to the end of the Map.
    this.map.delete(id);
    this.map.set(id, v);
    return v;
  }

  set(id: string, data: Float32Array): void {
    const existing = this.map.get(id);
    if (existing) {
      this.bytes -= existing.byteLength;
      this.map.delete(id);
    }
    this.map.set(id, data);
    this.bytes += data.byteLength;
    // Evict oldest (front of Map) until under budget, but never drop the entry
    // we just inserted even if it alone exceeds the budget.
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string;
      const v = this.map.get(oldest)!;
      this.bytes -= v.byteLength;
      this.map.delete(oldest);
    }
  }

  delete(id: string): void {
    const existing = this.map.get(id);
    if (!existing) return;
    this.bytes -= existing.byteLength;
    this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get size(): number {
    return this.map.size;
  }
}

// --- Helpers ---

function shortId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function getUserDataPath(): Promise<string> {
  return await host.dialogs.getUserDataPath();
}

async function zstdCompress(data: Uint8Array): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    host.zlib.zstdCompress(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err, out) => {
      if (err) reject(err);
      else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
    });
  });
}

async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    host.zlib.zstdDecompress(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err, out) => {
      if (err) reject(err);
      else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
    });
  });
}

async function writeFloat32Compressed(filePath: string, arr: Float32Array): Promise<void> {
  const raw = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  const compressed = await zstdCompress(raw);
  await host.fs.writeFile(filePath, Buffer.from(compressed));
}

async function readFloat32Compressed(filePath: string): Promise<Float32Array> {
  const buf = await host.fs.readFile(filePath);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = await zstdDecompress(bytes);
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
}

async function writeBytesCompressed(filePath: string, bytes: Uint8Array): Promise<void> {
  const compressed = await zstdCompress(bytes);
  await host.fs.writeFile(filePath, Buffer.from(compressed));
}

async function readBytesCompressed(filePath: string): Promise<Uint8Array> {
  const buf = await host.fs.readFile(filePath);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return await zstdDecompress(bytes);
}

function dimensionsFromSpectrogram(s: SpectrogramData): HistoryDimensions {
  return {
    textureWidth: s.textureWidth,
    textureHeight: s.textureHeight,
    numFrames: s.numFrames,
    numBands: s.numBands,
    numChannels: s.numChannels,
    sampleRate: s.sampleRate,
    minFreq: s.minFreq,
    bandsPerOctave: s.bandsPerOctave,
    magnitudeEnergy: s.magnitudeEnergy,
  };
}

// --- Manager ---

export interface AddSnapshotOpts {
  data: Float32Array;
  kind: "root" | "resize" | "reanalyze";
  label: string;
  spectrogram: SpectrogramData;
}

export interface AddStrokeOpts {
  data: Float32Array;
  label: string;
  dimensions: HistoryDimensions;
  // Packed-pixel ranges the brush footprint covers, as a flat
  // [pixelStart, pixelCount, ...] list (one range per band). The delta stores
  // exactly these pixels. Absent/null stores a full packed snapshot instead.
  dirtyRanges?: Uint32Array | null;
}

export class HistoryManager {
  private readonly fileId: string;
  private readonly dir: Promise<string>;
  private manifest: HistoryManifest | null = null;
  private initPromise: Promise<void> | null = null;
  private currentPacked: Float32Array | null = null;
  private audioLru: string[] = [];
  // ID of the full-snapshot node whose spectrogramData (inverseMap, metadata,
  // dimensions) currently reflects on the file. Used to avoid a redundant
  // reloadTextures() when navigating among nodes that share an anchor — which
  // is the common case for undo/redo within a single analysis.
  private lastLoadedAnchorId: string | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private manifestWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private manifestWritePending = false;
  private readonly packedCache = new PackedStateCache(PACKED_STATE_CACHE_BYTES);

  constructor(fileId: string) {
    this.fileId = fileId;
    this.dir = this.resolveDir();
  }

  /**
   * Subscribe to tree changes. Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Monotonically increasing version number. Incremented whenever the tree
   * mutates. Used as the snapshot identity for useSyncExternalStore so React
   * always sees a stable value between renders.
   */
  getVersion(): number {
    return this.version;
  }

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  private async resolveDir(): Promise<string> {
    const userData = await getUserDataPath();
    return host.path.join(userData, "history", this.fileId);
  }

  private async ensureDir(): Promise<string> {
    const dir = await this.dir;
    await host.fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async readManifest(): Promise<HistoryManifest | null> {
    try {
      const dir = await this.dir;
      const path = host.path.join(dir, MANIFEST_FILENAME);
      const buf = await host.fs.readFile(path, "utf8");
      const parsed = JSON.parse(buf as unknown as string) as { version?: number } & HistoryManifest;
      if (parsed.version !== HISTORY_MANIFEST_VERSION) {
        // A different manifest version uses an incompatible delta encoding that
        // would decode wrong, so wipe and start over.
        console.warn(
          `history: tree.json version ${parsed.version} is incompatible with ${HISTORY_MANIFEST_VERSION}, wiping`,
        );
        await host.fs.rm(dir, { recursive: true, force: true });
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeManifest(): Promise<void> {
    // Snapshot synchronously so a flush triggered just before dispose() nulls
    // the manifest still persists the captured tree across the await below.
    const manifest = this.manifest;
    if (!manifest) return;
    const dir = await this.ensureDir();
    const path = host.path.join(dir, MANIFEST_FILENAME);
    await host.fs.writeFile(path, JSON.stringify(manifest));
  }

  /**
   * Coalesce manifest writes during rapid navigation (e.g. holding Cmd+Z). The
   * on-disk currentId only needs to be eventually durable, so debouncing keeps
   * a fast undo/redo spree from doing a full tree.json write per step.
   */
  private scheduleManifestWrite(): void {
    this.manifestWritePending = true;
    if (this.manifestWriteTimer != null) return;
    this.manifestWriteTimer = setTimeout(() => {
      this.manifestWriteTimer = null;
      this.flushManifestWrite();
    }, MANIFEST_WRITE_DEBOUNCE_MS);
  }

  private flushManifestWrite(): void {
    if (this.manifestWriteTimer != null) {
      clearTimeout(this.manifestWriteTimer);
      this.manifestWriteTimer = null;
    }
    if (!this.manifestWritePending) return;
    this.manifestWritePending = false;
    void this.writeManifest();
  }

  /**
   * Load existing tree from disk if present. Returns true if a tree was loaded.
   */
  async initialize(): Promise<boolean> {
    if (this.initPromise) {
      await this.initPromise;
      return this.manifest !== null;
    }
    this.initPromise = (async () => {
      const loaded = await this.readManifest();
      if (loaded) {
        this.manifest = loaded;
        // The Ableton extension opens every clip at its original audio (the root
        // snapshot), keeping prior edits as branches in the tree rather than
        // jumping to the last-edited tip.
        if (host.env.isExtension) loaded.currentId = loaded.rootId;
        // The freshly-analyzed file on disk almost always matches the root's
        // dimensions (strokes don't change dims; resize/reanalyze either ran
        // and re-saved, or we're at root). Set lastLoadedAnchorId to the
        // nearest full ancestor of currentId so the first navigate doesn't do
        // a redundant reloadTextures. If it's wrong, the first cross-anchor
        // navigate will correct it.
        let cursor: HistoryNode | null = loaded.nodes[loaded.currentId] ?? null;
        while (cursor && cursor.storage !== "full") {
          cursor = cursor.parentId ? (loaded.nodes[cursor.parentId] ?? null) : null;
        }
        this.lastLoadedAnchorId = cursor?.id ?? null;
      }
    })();
    await this.initPromise;
    this.syncDirty();
    return this.manifest !== null;
  }

  isEmpty(): boolean {
    return this.manifest === null;
  }

  getManifest(): HistoryManifest | null {
    return this.manifest;
  }

  getCurrentId(): string | null {
    return this.manifest?.currentId ?? null;
  }

  getNode(id: string): HistoryNode | undefined {
    return this.manifest?.nodes[id];
  }

  listNodes(): HistoryNode[] {
    if (!this.manifest) return [];
    return Object.values(this.manifest.nodes);
  }

  canUndo(): boolean {
    if (!this.manifest) return false;
    const current = this.manifest.nodes[this.manifest.currentId];
    return current?.parentId != null;
  }

  canRedo(): boolean {
    if (!this.manifest) return false;
    const current = this.manifest.nodes[this.manifest.currentId];
    return current?.lastChildId != null;
  }

  private notifyStateChange(): void {
    ipcSend("update-menu-state", this.canUndo(), this.canRedo());
    this.syncDirty();
    this.emit();
  }

  // A file is dirty when the current node differs from the last-saved one, so
  // undoing back to the saved (or original) state clears dirty and redoing away
  // from it sets it again. Managed files have no on-disk audio to match and stay
  // dirty until promoted to a real file via Save As. In the extension nothing
  // calls markSaved (Save to Live spawns a new clip), so savedNodeId stays at
  // the root and dirty means "differs from the clip's original audio."
  private syncDirty(): void {
    if (!this.manifest) return;
    const file = openFiles[this.fileId];
    if (file?.filePath && isManagedFilePath(file.filePath)) {
      useStore.getState().setFileDirty(this.fileId, true);
      return;
    }
    const savedId = this.manifest.savedNodeId ?? this.manifest.rootId;
    useStore.getState().setFileDirty(this.fileId, this.manifest.currentId !== savedId);
  }

  // Record that the current node's audio has been written to disk, so it becomes
  // the clean reference for the dirty flag.
  async markSaved(): Promise<void> {
    await this.initialize();
    if (!this.manifest) return;
    this.manifest.savedNodeId = this.manifest.currentId;
    this.scheduleManifestWrite();
    this.syncDirty();
  }

  // ---------- File paths ----------

  private packedPath(dir: string, nodeId: string): string {
    return host.path.join(dir, `${nodeId}.packed.zst`);
  }
  private deltaPath(dir: string, nodeId: string): string {
    return host.path.join(dir, `${nodeId}.delta.zst`);
  }
  private inverseMapPath(dir: string, nodeId: string): string {
    return host.path.join(dir, `${nodeId}.inverse.zst`);
  }
  private metadataPath(dir: string, nodeId: string): string {
    return host.path.join(dir, `${nodeId}.meta.zst`);
  }
  private audioPath(dir: string, nodeId: string): string {
    return host.path.join(dir, `${nodeId}.wav`);
  }

  // ---------- Mutation ----------

  /**
   * Seed the manager with a full snapshot. Creates the root node and writes it.
   */
  async addRootSnapshot(opts: AddSnapshotOpts): Promise<string> {
    await this.initialize();
    if (this.manifest) {
      // Already initialised — treat as no-op.
      return this.manifest.rootId;
    }
    const id = shortId();
    const node: HistoryNode = {
      id,
      parentId: null,
      childIds: [],
      lastChildId: null,
      timestamp: Date.now(),
      label: opts.label,
      kind: opts.kind,
      storage: "full",
      dimensions: dimensionsFromSpectrogram(opts.spectrogram),
      synthesisMetadata: {
        bandOffsets: Array.from(opts.spectrogram.synthesisMetadata.bandOffsets),
        bandStepLog2s: Array.from(opts.spectrogram.synthesisMetadata.bandStepLog2s),
        bandLengths: Array.from(opts.spectrogram.synthesisMetadata.bandLengths),
      },
    };
    this.manifest = { version: HISTORY_MANIFEST_VERSION, rootId: id, currentId: id, nodes: { [id]: node } };
    await this.writeFullSnapshot(id, opts.data, opts.spectrogram);
    await this.writeManifest();
    this.currentPacked = new Float32Array(opts.data);
    this.packedCache.set(id, this.currentPacked);
    this.lastLoadedAnchorId = id;
    this.notifyStateChange();
    return id;
  }

  /**
   * Append a dimension-changing snapshot (resize/reanalyze) as a child of the current node.
   */
  async addSnapshot(opts: Omit<AddSnapshotOpts, "kind"> & { kind: "resize" | "reanalyze" }): Promise<string> {
    await this.initialize();
    if (!this.manifest) throw new Error("HistoryManager: cannot addSnapshot before root");

    const id = shortId();
    const parentId = this.manifest.currentId;
    const node: HistoryNode = {
      id,
      parentId,
      childIds: [],
      lastChildId: null,
      timestamp: Date.now(),
      label: opts.label,
      kind: opts.kind,
      storage: "full",
      dimensions: dimensionsFromSpectrogram(opts.spectrogram),
      synthesisMetadata: {
        bandOffsets: Array.from(opts.spectrogram.synthesisMetadata.bandOffsets),
        bandStepLog2s: Array.from(opts.spectrogram.synthesisMetadata.bandStepLog2s),
        bandLengths: Array.from(opts.spectrogram.synthesisMetadata.bandLengths),
      },
    };

    await this.writeFullSnapshot(id, opts.data, opts.spectrogram);
    this.linkChild(parentId, id);
    this.manifest.nodes[id] = node;
    this.manifest.currentId = id;
    this.currentPacked = new Float32Array(opts.data);
    this.packedCache.set(id, this.currentPacked);
    this.lastLoadedAnchorId = id;
    await this.writeManifest();
    this.notifyStateChange();
    return id;
  }

  /**
   * Append a stroke as a child of the current node. Stored as a footprint delta
   * when dimensions match and the brush footprint is known and covers less than
   * half the texture, otherwise as a full packed snapshot.
   */
  async addStroke(opts: AddStrokeOpts): Promise<string> {
    await this.initialize();
    if (!this.manifest) throw new Error("HistoryManager: cannot addStroke before root");

    const id = shortId();
    const parentId = this.manifest.currentId;
    const parent = this.manifest.nodes[parentId];
    const sameDims =
      parent.dimensions.textureWidth === opts.dimensions.textureWidth &&
      parent.dimensions.textureHeight === opts.dimensions.textureHeight;

    const base = this.currentPacked;
    const ranges = opts.dirtyRanges;
    let footprintPixels = 0;
    if (ranges) for (let r = 1; r < ranges.length; r += 2) footprintPixels += ranges[r];
    const texturePixels = opts.dimensions.textureWidth * opts.dimensions.textureHeight;

    let storage: "delta" | "packed";
    let deltaBytes: Uint8Array | undefined;

    if (
      sameDims &&
      base != null &&
      base.length === opts.data.length &&
      ranges != null &&
      ranges.length > 0 &&
      footprintPixels < texturePixels * 0.5
    ) {
      const deltaStart = performance.now();
      if (!footprintChanged(base, opts.data, ranges)) {
        return parentId;
      }
      const stepsSinceSnap = this.deltaStepsSinceLastSnap(parentId);
      if (stepsSinceSnap >= CHECKPOINT_INTERVAL) {
        storage = "packed";
      } else {
        storage = "delta";
        deltaBytes = encodeFootprintDelta(opts.data, ranges);
      }
      console.log(
        `[timing] addStroke: footprint delta ${(performance.now() - deltaStart).toFixed(1)}ms ` +
          `(${ranges.length / 2} ranges, ${footprintPixels} px)`,
      );
    } else {
      storage = "packed";
    }

    const node: HistoryNode = {
      id,
      parentId,
      childIds: [],
      lastChildId: null,
      timestamp: Date.now(),
      label: opts.label,
      kind: storage === "packed" && !sameDims ? "root" : storage === "packed" ? "checkpoint" : "stroke",
      storage,
      dimensions: opts.dimensions,
    };

    const dir = await this.ensureDir();
    if (storage === "delta" && deltaBytes) {
      await writeBytesCompressed(this.deltaPath(dir, id), deltaBytes);
    } else {
      await writeFloat32Compressed(this.packedPath(dir, id), opts.data);
    }

    this.linkChild(parentId, id);
    this.manifest.nodes[id] = node;
    this.manifest.currentId = id;
    // opts.data is the fresh readback buffer and is never mutated, so it can be
    // retained directly rather than copied.
    this.currentPacked = opts.data;
    this.packedCache.set(id, this.currentPacked);
    await this.writeManifest();
    this.notifyStateChange();
    return id;
  }

  private deltaStepsSinceLastSnap(fromId: string): number {
    if (!this.manifest) return 0;
    let count = 0;
    let cursor: string | null = fromId;
    while (cursor) {
      const n = this.manifest.nodes[cursor];
      if (!n) break;
      if (n.storage !== "delta") break;
      count++;
      cursor = n.parentId;
    }
    return count;
  }

  private linkChild(parentId: string, childId: string): void {
    if (!this.manifest) return;
    const parent = this.manifest.nodes[parentId];
    if (!parent) return;
    if (!parent.childIds.includes(childId)) parent.childIds.push(childId);
    parent.lastChildId = childId;
  }

  // ---------- Full-snapshot I/O ----------

  private async writeFullSnapshot(nodeId: string, packed: Float32Array, s: SpectrogramData): Promise<void> {
    await this.writeFullSnapshotParts(nodeId, packed, s.inverseMap, s.metadata);
  }

  private async writeFullSnapshotParts(
    nodeId: string,
    packed: Float32Array,
    inverseMap: Float32Array,
    metadata: Float32Array,
  ): Promise<void> {
    const dir = await this.ensureDir();
    await writeFloat32Compressed(this.packedPath(dir, nodeId), packed);
    await writeFloat32Compressed(this.inverseMapPath(dir, nodeId), inverseMap);
    await writeFloat32Compressed(this.metadataPath(dir, nodeId), metadata);
  }

  private async readFullSnapshot(node: HistoryNode): Promise<{
    packedData: Float32Array;
    inverseMap: Float32Array;
    metadata: Float32Array;
  }> {
    const dir = await this.dir;
    const [packedData, inverseMap, metadata] = await Promise.all([
      readFloat32Compressed(this.packedPath(dir, node.id)),
      readFloat32Compressed(this.inverseMapPath(dir, node.id)),
      readFloat32Compressed(this.metadataPath(dir, node.id)),
    ]);
    return { packedData, inverseMap, metadata };
  }

  // Read just the side-data of a full snapshot (inverseMap + metadata), without
  // the packed FBO data. Used by loadSpectrogramAtCurrent so it doesn't redo
  // work that reconstruct() has already done for the anchor.
  private async readFullSnapshotSideData(node: HistoryNode): Promise<{
    inverseMap: Float32Array;
    metadata: Float32Array;
  }> {
    const dir = await this.dir;
    const [inverseMap, metadata] = await Promise.all([
      readFloat32Compressed(this.inverseMapPath(dir, node.id)),
      readFloat32Compressed(this.metadataPath(dir, node.id)),
    ]);
    return { inverseMap, metadata };
  }

  // ---------- Reconstruction ----------

  /**
   * Walk ancestors to find the nearest full/packed snapshot, then apply deltas forward.
   * Returns the reconstructed packed data and — if the anchor is a full snapshot —
   * the associated inverseMap/metadata needed to restore SpectrogramData.
   */
  async reconstruct(nodeId: string): Promise<{
    packedData: Float32Array;
    node: HistoryNode;
    fullAnchor?: HistoryNode;
  }> {
    if (!this.manifest) throw new Error("HistoryManager: empty manifest");
    const target = this.manifest.nodes[nodeId];
    if (!target) throw new Error(`HistoryManager: unknown node ${nodeId}`);

    const chain: HistoryNode[] = [];
    let cursor: HistoryNode | null = target;
    while (cursor) {
      chain.unshift(cursor);
      if (cursor.storage !== "delta") break;
      cursor = cursor.parentId ? (this.manifest.nodes[cursor.parentId] ?? null) : null;
    }

    const anchor = chain[0];
    const dir = await this.dir;
    let packed = await readFloat32Compressed(this.packedPath(dir, anchor.id));

    for (let i = 1; i < chain.length; i++) {
      const n = chain[i];
      if (n.storage === "delta") {
        const { ranges, patch } = decodeFootprintDelta(await readBytesCompressed(this.deltaPath(dir, n.id)));
        packed = applyFootprintDelta(packed, ranges, patch);
      } else if (n.storage === "packed") {
        packed = await readFloat32Compressed(this.packedPath(dir, n.id));
      } else {
        throw new Error(`HistoryManager: unexpected storage in reconstruct: ${n.storage}`);
      }
    }

    return {
      packedData: packed,
      node: target,
      fullAnchor: anchor.storage === "full" ? anchor : undefined,
    };
  }

  /**
   * Walk ancestors to the nearest full snapshot (resize/reanalyze or root) — the
   * node whose inverseMap/metadata/synthesisMetadata describe `nodeId`'s
   * dimensions. Packed checkpoints are skipped since they share their full
   * ancestor's side-data. Used to decide whether navigation crossed a dimension
   * boundary and so needs reloadTextures.
   */
  private nearestFullAnchor(nodeId: string): HistoryNode | null {
    if (!this.manifest) return null;
    let cursor: HistoryNode | null = this.manifest.nodes[nodeId] ?? null;
    while (cursor && cursor.storage !== "full") {
      cursor = cursor.parentId ? (this.manifest.nodes[cursor.parentId] ?? null) : null;
    }
    return cursor;
  }

  /**
   * Reconstruct the SpectrogramData at the current node from on-disk history,
   * without needing a renderer to be attached. Used by reopenPersistedFiles to
   * skip gaborator on launch — the root snapshot already has every shape we need
   * (dimensions, inverseMap, metadata, synthesisMetadata) and stroke deltas
   * forward from the nearest full anchor reproduce the painted state.
   *
   * Side effect: caches currentPacked so future addStroke deltas compute
   * against the correct base.
   */
  async loadSpectrogramAtCurrent(): Promise<SpectrogramData | null> {
    await this.initialize();
    if (!this.manifest) return null;
    const targetId = this.manifest.currentId;
    if (!this.manifest.nodes[targetId]) return null;

    // reconstruct() walks back to the nearest full anchor and reads its packed
    // data once, then applies deltas forward. We piggyback on that walk to
    // know the anchor identity, and only fetch its side data (inverseMap +
    // metadata) — which reconstruct doesn't need but spectrogramData does.
    const { packedData, fullAnchor } = await this.reconstruct(targetId);
    if (!fullAnchor || !fullAnchor.synthesisMetadata) return null;

    const { inverseMap, metadata } = await this.readFullSnapshotSideData(fullAnchor);
    this.currentPacked = new Float32Array(packedData);

    const dims = fullAnchor.dimensions;
    return {
      packedData,
      inverseMap,
      metadata,
      textureWidth: dims.textureWidth,
      textureHeight: dims.textureHeight,
      numFrames: dims.numFrames,
      numBands: dims.numBands,
      numChannels: dims.numChannels,
      sampleRate: dims.sampleRate,
      minFreq: dims.minFreq,
      bandsPerOctave: dims.bandsPerOctave,
      magnitudeEnergy: dims.magnitudeEnergy,
      packedTextureSize: new Vector2(dims.textureWidth, dims.textureHeight),
      synthesisMetadata: {
        bandOffsets: new Uint32Array(fullAnchor.synthesisMetadata.bandOffsets),
        bandStepLog2s: new Int32Array(fullAnchor.synthesisMetadata.bandStepLog2s),
        bandLengths: new Uint32Array(fullAnchor.synthesisMetadata.bandLengths),
      },
    };
  }

  /**
   * Restore the audio for the current node — cached WAV if present, otherwise
   * trigger fresh synthesis. Called after FileRenderer mounts on reopen so the
   * file is immediately playable from where the user left off.
   */
  async restoreCurrentAudio(): Promise<void> {
    await this.initialize();
    if (!this.manifest) return;
    const targetId = this.manifest.currentId;
    const target = this.manifest.nodes[targetId];
    if (!target) return;
    const dir = await this.dir;
    const audioPath = this.audioPath(dir, targetId);
    if (target.audioCached && target.audioPeak != null) {
      const { loadCachedAudio } = useStore.getState();
      const loaded = await loadCachedAudio(this.fileId, audioPath, target.audioPeak);
      if (loaded) {
        this.touchAudioLru(targetId);
        return;
      }
      target.audioCached = false;
    }
    const { synthesizeFile } = useStore.getState();
    void synthesizeFile(this.fileId);
  }

  // ---------- Navigation ----------

  /**
   * Navigate to an arbitrary node. Restores the FBO data and the spectrogramData if the
   * target lineage crosses a full snapshot. Updates lastChildId along the path.
   * Caller should await this; audio is restored from cached WAV if present, else synthesised.
   */
  async navigateTo(targetId: string): Promise<void> {
    await this.initialize();
    if (!this.manifest) return;
    const target = this.manifest.nodes[targetId];
    if (!target) return;
    const file = openFiles[this.fileId];
    if (!file?.rendererRef?.current) return;

    // Walk from target to root, recording each ancestor's branch choice so that
    // lastChildId sits on the current path after navigation.
    const toRoot: string[] = [];
    let cursor: string | null = targetId;
    while (cursor) {
      toRoot.push(cursor);
      const n = this.manifest.nodes[cursor];
      cursor = n?.parentId ?? null;
    }
    for (let i = toRoot.length - 1; i > 0; i--) {
      const parent = this.manifest.nodes[toRoot[i]];
      if (parent) parent.lastChildId = toRoot[i - 1];
    }

    // Reuse the cached canonical packed state when we've recently visited the
    // target (the common undo/redo case) — it's the exact array that was last on
    // screen, so round-trips are lossless and need no disk read / decompress /
    // delta replay. On a miss, rebuild from the nearest checkpoint on disk.
    let packedData = this.packedCache.get(targetId);
    if (!packedData) {
      packedData = (await this.reconstruct(targetId)).packedData;
    }

    // Only rebuild textures and swap spectrogramData when the full-snapshot
    // anchor has actually changed (i.e. we crossed a resize/reanalyze boundary).
    // For typical undo/redo within a single analysis, the file's existing
    // inverseMap/metadata/dims are still correct — just push the new FBO bytes.
    const anchor = this.nearestFullAnchor(targetId);
    if (anchor && anchor.id !== this.lastLoadedAnchorId) {
      await this.restoreSpectrogramFromFull(anchor, packedData);
      this.lastLoadedAnchorId = anchor.id;
    } else {
      file.rendererRef.current.setFBOData(packedData);
    }

    this.manifest.currentId = targetId;
    // packedData is either a cache entry or a freshly reconstructed array; both
    // are safe to share (currentPacked is never mutated in place, only replaced).
    this.currentPacked = packedData;
    this.packedCache.set(targetId, packedData);
    this.scheduleManifestWrite();
    this.notifyStateChange();

    // Restore audio: cached WAV if present, otherwise re-synthesize.
    const dir = await this.dir;
    const audioPath = this.audioPath(dir, targetId);
    if (target.audioCached && target.audioPeak != null) {
      const { loadCachedAudio } = useStore.getState();
      const loaded = await loadCachedAudio(this.fileId, audioPath, target.audioPeak);
      if (loaded) {
        this.touchAudioLru(targetId);
        return;
      }
      target.audioCached = false;
    }
    const { synthesizeFile } = useStore.getState();
    void synthesizeFile(this.fileId);
  }

  async navigateToParent(): Promise<void> {
    const id = this.manifest?.nodes[this.manifest.currentId]?.parentId;
    if (!id) return;
    await this.navigateTo(id);
  }

  async navigateToLastChild(): Promise<void> {
    const id = this.manifest?.nodes[this.manifest.currentId]?.lastChildId;
    if (!id) return;
    await this.navigateTo(id);
  }

  private async restoreSpectrogramFromFull(anchor: HistoryNode, packedData: Float32Array): Promise<void> {
    const file = openFiles[this.fileId];
    if (!file?.rendererRef?.current) return;
    const { inverseMap, metadata } = await this.readFullSnapshot(anchor);
    const dims = anchor.dimensions;
    const synthMeta = anchor.synthesisMetadata!;
    const spectrogramData: SpectrogramData = {
      packedData,
      inverseMap,
      metadata,
      textureWidth: dims.textureWidth,
      textureHeight: dims.textureHeight,
      numFrames: dims.numFrames,
      numBands: dims.numBands,
      numChannels: dims.numChannels,
      sampleRate: dims.sampleRate,
      minFreq: dims.minFreq,
      bandsPerOctave: dims.bandsPerOctave,
      magnitudeEnergy: dims.magnitudeEnergy,
      packedTextureSize: new Vector2(dims.textureWidth, dims.textureHeight),
      synthesisMetadata: {
        bandOffsets: new Uint32Array(synthMeta.bandOffsets),
        bandStepLog2s: new Int32Array(synthMeta.bandStepLog2s),
        bandLengths: new Uint32Array(synthMeta.bandLengths),
      },
    };
    file.spectrogramData = spectrogramData;
    file.rendererRef.current.reloadTextures();
    file.rendererRef.current.setFBOData(packedData);
  }

  // ---------- Audio LRU ----------

  async setStateAudio(nodeId: string, audioBuffer: AudioBuffer, peak: number): Promise<void> {
    await this.initialize();
    if (!this.manifest) return;
    const node = this.manifest.nodes[nodeId];
    if (!node) return;
    const dir = await this.ensureDir();
    const channels: Float32Array[] = [];
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
      channels.push(new Float32Array(audioBuffer.getChannelData(i)));
    }
    const path = this.audioPath(dir, nodeId);
    try {
      await host.analysis.exportAudio(channels, path, audioBuffer.sampleRate, "wav");
    } catch (err) {
      console.error("history: failed to cache audio", err);
      return;
    }
    node.audioCached = true;
    node.audioPeak = peak;
    this.touchAudioLru(nodeId);
    await this.enforceAudioLru();
    await this.writeManifest();
    this.emit();
  }

  private touchAudioLru(nodeId: string): void {
    this.audioLru = [nodeId, ...this.audioLru.filter((id) => id !== nodeId)];
  }

  private async enforceAudioLru(): Promise<void> {
    if (!this.manifest) return;
    while (this.audioLru.length > AUDIO_LRU_CAPACITY) {
      const evict = this.audioLru.pop();
      if (!evict) break;
      const node = this.manifest.nodes[evict];
      if (!node || !node.audioCached) continue;
      const dir = await this.dir;
      host.fs.rm(this.audioPath(dir, evict)).catch(() => {});
      node.audioCached = false;
    }
  }

  // ---------- Metadata ----------

  async renameNode(nodeId: string, label: string): Promise<void> {
    if (!this.manifest) return;
    const n = this.manifest.nodes[nodeId];
    if (!n) return;
    n.customLabel = label.trim() || undefined;
    await this.writeManifest();
    this.emit();
  }

  async toggleFavorite(nodeId: string): Promise<void> {
    if (!this.manifest) return;
    const n = this.manifest.nodes[nodeId];
    if (!n) return;
    n.favorited = !n.favorited;
    if (!n.favorited) delete n.favorited;
    await this.writeManifest();
    this.emit();
  }

  /**
   * Remove a node and all descendants. If the current node is inside the deleted
   * subtree, current is moved to the deleted node's parent.
   */
  async deleteSubtree(nodeId: string): Promise<void> {
    if (!this.manifest) return;
    const root = this.manifest.nodes[nodeId];
    if (!root || root.id === this.manifest.rootId) return;

    const dir = await this.dir;
    const toDelete: string[] = [];
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop()!;
      toDelete.push(id);
      const n = this.manifest.nodes[id];
      if (n) stack.push(...n.childIds);
    }

    for (const id of toDelete) {
      const files = [
        this.packedPath(dir, id),
        this.deltaPath(dir, id),
        this.inverseMapPath(dir, id),
        this.metadataPath(dir, id),
        this.audioPath(dir, id),
      ];
      for (const f of files) host.fs.rm(f).catch(() => {});
      this.packedCache.delete(id);
      delete this.manifest.nodes[id];
    }

    if (root.parentId) {
      const parent = this.manifest.nodes[root.parentId];
      if (parent) {
        parent.childIds = parent.childIds.filter((id) => id !== nodeId);
        if (parent.lastChildId === nodeId) {
          parent.lastChildId = parent.childIds[parent.childIds.length - 1] ?? null;
        }
      }
    }

    if (toDelete.includes(this.manifest.currentId)) {
      const fallback = root.parentId ?? this.manifest.rootId;
      this.manifest.currentId = fallback;
      await this.navigateTo(fallback);
    } else {
      await this.writeManifest();
    }
    this.notifyStateChange();
  }

  /**
   * Render the audio for an arbitrary node directly to a WAV file, without
   * mutating the file's displayed state. Uses the cached WAV if present,
   * otherwise reconstructs the packed FBO data and synthesizes fresh audio.
   */
  // Re-synthesises a node's audio from its packed spectrogram, returning the
  // planar channels and sample rate. Returns null when the node or its synthesis
  // metadata can't be resolved.
  async synthesizeNodeAudio(nodeId: string): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
    await this.initialize();
    if (!this.manifest) return null;
    const target = this.manifest.nodes[nodeId];
    if (!target) return null;

    // Walk ancestors to the nearest full snapshot — it carries the
    // synthesisMetadata (bandOffsets/bandStepLog2s/bandLengths) needed by the
    // gaborator synthesizer. Stroke chains inherit those from their last
    // resize/reanalyze ancestor.
    let anchor: HistoryNode | null = target;
    while (anchor && anchor.storage !== "full") {
      anchor = anchor.parentId ? (this.manifest.nodes[anchor.parentId] ?? null) : null;
    }
    if (!anchor?.synthesisMetadata) return null;

    const { packedData } = await this.reconstruct(nodeId);
    const dims = target.dimensions;
    const synthMeta = {
      numFrames: dims.numFrames,
      numChannels: dims.numChannels,
      numBands: dims.numBands,
      bandOffsets: new Uint32Array(anchor.synthesisMetadata.bandOffsets),
      bandStepLog2s: new Int32Array(anchor.synthesisMetadata.bandStepLog2s),
      bandLengths: new Uint32Array(anchor.synthesisMetadata.bandLengths),
    };
    const result = await host.analysis.synthesize(
      packedData,
      synthMeta,
      dims.sampleRate,
      { bandsPerOctave: dims.bandsPerOctave, minFreq: dims.minFreq },
      true,
    );
    return { channels: result.channels, sampleRate: dims.sampleRate };
  }

  async exportNodeAudio(nodeId: string, outputPath: string): Promise<boolean> {
    await this.initialize();
    if (!this.manifest) return false;
    const target = this.manifest.nodes[nodeId];
    if (!target) return false;

    // Fast path: if the node has a cached WAV on disk, copy it directly.
    if (target.audioCached) {
      const dir = await this.dir;
      const cached = this.audioPath(dir, nodeId);
      try {
        await host.analysis.copyAudioFile(cached, outputPath);
        return true;
      } catch {
        // Cached copy failed (file evicted or permission issue) — fall through
        // to re-synthesis without mutating the manifest.
      }
    }

    const audio = await this.synthesizeNodeAudio(nodeId);
    if (!audio) return false;
    await host.analysis.exportAudio(audio.channels, outputPath, audio.sampleRate, "wav");
    return true;
  }

  async getDiskUsageBytes(): Promise<number> {
    try {
      const dir = await this.dir;
      const entries = await host.fs.readdir(dir);
      let total = 0;
      for (const entry of entries) {
        try {
          const s = await host.fs.stat(host.path.join(dir, entry));
          total += Number(s.size);
        } catch {
          // ignore
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  /**
   * Collapse the tree to a single root holding the current state, freeing every
   * other node's on-disk data. Unlike purge(), the manager keeps a valid root, so
   * undo/redo and future strokes work from here instead of the next addStroke
   * throwing on a null manifest. The visible spectrogram, its cached audio, and
   * the dirty flag are preserved — purging history doesn't change the file.
   */
  async resetToCurrent(): Promise<void> {
    await this.initialize();
    if (!this.manifest) return;
    const currentId = this.manifest.currentId;
    const current = this.manifest.nodes[currentId];
    if (!current) return;

    // The current state's dimension side-data (inverseMap/metadata/synthesis
    // metadata) lives on its nearest full-snapshot ancestor; capture it before
    // the ancestors are deleted below.
    const anchor = this.nearestFullAnchor(currentId);
    if (!anchor?.synthesisMetadata) return;
    const { inverseMap, metadata } = await this.readFullSnapshotSideData(anchor);
    const packed = this.currentPacked ?? (await this.reconstruct(currentId)).packedData;

    // Drop any pending debounced write — the tree is about to be rewritten.
    this.manifestWritePending = false;
    if (this.manifestWriteTimer != null) {
      clearTimeout(this.manifestWriteTimer);
      this.manifestWriteTimer = null;
    }

    const dir = await this.dir;
    // Delete every other node's on-disk data. The current node's cached audio is
    // kept because its id is preserved as the new root.
    for (const id of Object.keys(this.manifest.nodes)) {
      if (id === currentId) continue;
      for (const f of [
        this.packedPath(dir, id),
        this.deltaPath(dir, id),
        this.inverseMapPath(dir, id),
        this.metadataPath(dir, id),
        this.audioPath(dir, id),
      ]) {
        host.fs.rm(f).catch(() => {});
      }
      this.packedCache.delete(id);
    }

    // Rewrite the current node as a standalone full snapshot so it can be the
    // root with no ancestors left to reconstruct from.
    host.fs.rm(this.deltaPath(dir, currentId)).catch(() => {});
    await this.writeFullSnapshotParts(currentId, packed, inverseMap, metadata);

    current.parentId = null;
    current.childIds = [];
    current.lastChildId = null;
    current.storage = "full";
    current.synthesisMetadata = {
      bandOffsets: Array.from(anchor.synthesisMetadata.bandOffsets),
      bandStepLog2s: Array.from(anchor.synthesisMetadata.bandStepLog2s),
      bandLengths: Array.from(anchor.synthesisMetadata.bandLengths),
    };

    this.manifest.rootId = currentId;
    this.manifest.nodes = { [currentId]: current };
    // savedNodeId is left untouched: purging on-disk history doesn't change
    // whether the current audio matches the last save, so the dirty flag carries
    // over (a now-deleted savedNodeId still reads as "differs from saved").

    const canonical = new Float32Array(packed);
    this.currentPacked = canonical;
    this.packedCache.clear();
    this.packedCache.set(currentId, canonical);
    this.audioLru = current.audioCached ? [currentId] : [];
    this.lastLoadedAnchorId = currentId;

    await this.writeManifest();
    this.notifyStateChange();
  }

  /**
   * Wipe the entire tree and directory. Next call to add* will re-seed from the root.
   */
  async purge(): Promise<void> {
    // Drop any pending debounced write — the tree is about to be wiped.
    this.manifestWritePending = false;
    if (this.manifestWriteTimer != null) {
      clearTimeout(this.manifestWriteTimer);
      this.manifestWriteTimer = null;
    }
    const dir = await this.dir;
    try {
      await host.fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    this.manifest = null;
    this.currentPacked = null;
    this.packedCache.clear();
    this.audioLru = [];
    this.lastLoadedAnchorId = null;
    this.notifyStateChange();
  }

  /**
   * Drop in-memory state. On-disk history is preserved so it can be rehydrated
   * on the next launch.
   */
  dispose(): void {
    // Persist any debounced navigation before dropping in-memory state, so a
    // quit mid-undo-spree doesn't lose the latest currentId. writeManifest
    // snapshots the manifest synchronously, so nulling it below is safe.
    this.flushManifestWrite();
    this.manifest = null;
    this.currentPacked = null;
    this.packedCache.clear();
    this.audioLru = [];
    this.lastLoadedAnchorId = null;
    this.listeners.clear();
  }
}

// Global instances per fileId.
const managers = new Map<string, HistoryManager>();

export function getHistoryManager(fileId: string): HistoryManager {
  let m = managers.get(fileId);
  if (!m) {
    m = new HistoryManager(fileId);
    managers.set(fileId, m);
  }
  return m;
}

/**
 * Called when the user closes a file tab — deletes on-disk history permanently.
 */
export async function destroyHistoryManager(fileId: string): Promise<void> {
  const m = managers.get(fileId);
  if (!m) return;
  await m.purge();
  managers.delete(fileId);
}

/**
 * Called on app quit — drops in-memory state only. On-disk history is preserved.
 */
export function clearAllHistoryManagers(): void {
  for (const m of managers.values()) m.dispose();
  managers.clear();
}

/**
 * Delete history directories that don't correspond to any of the persisted
 * fileIds. Catches orphans left by crashes or by close paths that didn't get
 * to run destroyHistoryManager. Called once at app startup.
 */
export async function pruneOrphanHistoryDirs(activeFileIds: Set<string>): Promise<void> {
  try {
    const userData = await getUserDataPath();
    const root = host.path.join(userData, "history");
    let entries: string[];
    try {
      entries = (await host.fs.readdir(root)) as unknown as string[];
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (activeFileIds.has(entry)) return;
        const dir = host.path.join(root, entry);
        try {
          await host.fs.rm(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }),
    );
  } catch {
    // best-effort
  }
}
