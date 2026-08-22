import { Vector2 } from "three";
import { useStore } from "@renderer/store";
import { awaitFileSynthesis, openFiles } from "@renderer/store/files";
import type { SpectrogramData } from "@renderer/store/types";
import { isManagedFilePath } from "@renderer/store/managed-path";
import type { PhaseTurns } from "../../../main/lib/types";
import { hasPhaseTurns, phaseTurnResidualRanges } from "../../../main/lib/history-delta";
import { audioHopBytes, editsAlongHops, type AudioHop } from "./audio-hop";
import { applyCanvasTurns, type CanvasTurn } from "./canvas-phase-turns";
import { clearCanvasPatchStash, takeCanvasPatchStash } from "./canvas-patch-stash";
import { diag } from "./diag-log";
import { clearFileTaskQueue, drainFileTaskQueues, serializeFileTask } from "./file-task-queue";
import { host } from "./host";
import { mergePixelRanges } from "./pixel-ranges";

const MANIFEST_FILENAME = "tree.json";
const CHECKPOINT_INTERVAL = 20;
const AUDIO_LRU_CAPACITY = 50;
const AUDIO_LRU_BYTES = 512 * 1024 * 1024;
// WavPack: lossless for the float samples synthesis produces, and about a
// quarter smaller than the float32 WAV it replaces.
const AUDIO_CACHE_FORMAT = "wv";
const MANIFEST_WRITE_DEBOUNCE_MS = 400;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * In-memory cache budgets: decoded packed states, the per-stroke coefficient
 * deltas that carry undo and redo, and the audio either side of each hop's
 * window. Full size from 16 GiB of system memory, a quarter of it at 8 GiB,
 * and in proportion between.
 */
export function historyCacheBudgets(totalMemoryBytes: number): {
  packedStates: number;
  deltas: number;
  audioHops: number;
} {
  const position = Math.min(1, Math.max(0, (totalMemoryBytes - 8 * GIB) / (8 * GIB)));
  const scale = 0.25 + 0.75 * position;
  return {
    packedStates: Math.round(256 * MIB * scale),
    deltas: Math.round(128 * MIB * scale),
    audioHops: Math.round(256 * MIB * scale),
  };
}

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
  // Band layout of the analysis this node belongs to. Enough to rebuild the
  // spectrogram's inverseMap and metadata, which are therefore not stored.
  synthesisMetadata?: {
    bandOffsets: number[];
    bandStepLog2s: number[];
    bandLengths: number[];
    bandFreqs: number[];
  };
  audioPeak?: number;
  audioCached?: boolean;
  // Whether this node's onsets are stored next to it (see setNodeOnsets).
  onsetsCached?: boolean;
  // Whether this node's coefficients hold paint no projection passed over.
  // Absent on nodes written before it was recorded, which read as false.
  unprojectedPaint?: boolean;
  customLabel?: string;
  favorited?: boolean;
}

const HISTORY_MANIFEST_VERSION = 4;

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

/**
 * Storage of a stroke. A stroke changes only the pixels under the brush, given
 * as packed-pixel ranges — one contiguous range per frequency band, because the
 * packed texture stores each band's time-series at its own offset, so a single
 * time-window spans many disjoint ranges.
 *
 * A stroke is stored as the difference from the state it was painted onto, and
 * the packed states themselves are reordered before compression. Both passes
 * walk buffers that reach hundreds of megabytes on a multi-minute file, so both
 * live in the addon (see host.analysis) and run off the renderer thread; the
 * codec is exactly lossless, so repeated undo/redo never drifts.
 */

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

  /** Drops every entry holding this very array, except the one named. */
  deleteValue(value: Float32Array, exceptId?: string): void {
    for (const [id, v] of [...this.map.entries()]) {
      if (v === value && id !== exceptId) this.delete(id);
    }
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

  get byteCount(): number {
    return this.bytes;
  }
}

/** LRU keyed by node id, bounded by the bytes its values hold. */
export class ByteBudgetCache<T> {
  private readonly map = new Map<string, T>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly sizeOf: (value: T) => number,
  ) {}

  get byteCount(): number {
    return this.bytes;
  }

  get(id: string): T | undefined {
    const v = this.map.get(id);
    if (v === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, v);
    return v;
  }

  /** Stores the value unless it alone would overrun the budget. */
  set(id: string, value: T): void {
    const size = this.sizeOf(value);
    if (size > this.maxBytes) return;
    this.delete(id);
    this.map.set(id, value);
    this.bytes += size;
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string;
      this.delete(oldest);
    }
  }

  delete(id: string): void {
    const existing = this.map.get(id);
    if (existing === undefined) return;
    this.bytes -= this.sizeOf(existing);
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

// Packed FBO data is reordered and compressed by the addon, off this thread.
async function writePackedCompressed(filePath: string, arr: Float32Array): Promise<void> {
  const blob = await host.analysis.encodeHistorySnapshot(arr);
  await host.fs.writeFile(filePath, Buffer.from(blob));
}

async function readPackedCompressed(filePath: string): Promise<Float32Array> {
  const buf = await host.fs.readFile(filePath);
  return await host.analysis.decodeHistorySnapshot(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

// The band layout the analysis produced. bandFreqs is only carried in the
// metadata texture (one float per band), so it is read back out of there.
function synthesisMetadataFromSpectrogram(s: SpectrogramData): NonNullable<HistoryNode["synthesisMetadata"]> {
  const bandFreqs: number[] = [];
  for (let b = 0; b < s.numBands; b++) bandFreqs.push(s.metadata[b * 4 + 3]);
  return {
    bandOffsets: Array.from(s.synthesisMetadata.bandOffsets),
    bandStepLog2s: Array.from(s.synthesisMetadata.bandStepLog2s),
    bandLengths: Array.from(s.synthesisMetadata.bandLengths),
    bandFreqs,
  };
}

/**
 * Rebuild a full snapshot's inverseMap and metadata textures from its band
 * layout. Both are pure functions of that layout — the analysis writes the same
 * values every time — so storing them alongside every full snapshot would cost
 * half a megabyte to save a loop that runs in a few milliseconds.
 */
export async function deriveSideData(node: HistoryNode): Promise<{
  inverseMap: Float32Array;
  metadata: Float32Array;
}> {
  const { textureWidth, textureHeight, numBands } = node.dimensions;
  const layout = node.synthesisMetadata;
  if (!layout) throw new Error(`HistoryManager: node ${node.id} has no band layout`);

  // The inverse map has an entry per packed pixel, so the addon fills it; the
  // metadata texture is four floats per band and stays here.
  const inverseMap = await host.analysis.buildHistoryInverseMap(
    new Uint32Array(layout.bandOffsets),
    new Uint32Array(layout.bandLengths),
    new Int32Array(layout.bandStepLog2s),
    textureWidth * textureHeight,
  );

  const metadata = new Float32Array(numBands * 4);
  for (let band = 0; band < numBands; band++) {
    metadata[band * 4] = layout.bandOffsets[band];
    metadata[band * 4 + 1] = layout.bandLengths[band];
    metadata[band * 4 + 2] = layout.bandStepLog2s[band];
    metadata[band * 4 + 3] = layout.bandFreqs[band];
  }
  return { inverseMap, metadata };
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

/**
 * Where a stroke landed. `isNew` is false when the stroke changed nothing and
 * the tree stayed where it was, so its caches belong to the parent already.
 */
export interface AddStrokeOutcome {
  id: string;
  isNew: boolean;
}

export interface AddStrokeOpts {
  data: Float32Array;
  label: string;
  dimensions: HistoryDimensions;
  // Packed-pixel ranges the brush footprint covers, as a flat
  // [pixelStart, pixelCount, ...] list (one range per band). The delta stores
  // exactly these pixels. Absent/null stores a full packed snapshot instead.
  dirtyRanges?: Uint32Array | null;
  // The uv rect whose audio this stroke changed. A projection's phase re-branch
  // can spread dirtyRanges to the end of the file while leaving that span's
  // audio identical, so this can be far smaller. Absent means unknown — the
  // whole file may have changed.
  audioRegion?: UvRegion | null;
  // Whether the state this stroke leaves holds paint no projection passed over.
  unprojectedPaint?: boolean;
  // When `data` is the current packed state written in place, the values the
  // dirty ranges held before the stroke, laid end to end in range order.
  baseFootprint?: Float32Array;
  // Whole-turn phase shifts the stroke's projection made past its ranges.
  turns?: PhaseTurns;
}

/** An axis-aligned region in unpacked display uv (Y 0 at the highest band's top). */
export type UvRegion = { startX: number; endX: number; startY: number; endY: number };

/**
 * The unpacked-UV rectangle a set of packed-pixel ranges covers, from the
 * band layout: each linear pixel index is bandOffsets[b] + timeIndex, and a
 * time index spans 2^bandStepLog2s[b] frames. Null when the ranges cover
 * nothing. Y follows the display convention: 0 at the highest band's top.
 */
export function packedRangesToUvRegion(
  ranges: Uint32Array,
  layout: { bandOffsets: Uint32Array; bandLengths: Uint32Array; bandStepLog2s: Int32Array },
  numFrames: number,
  numBands: number,
): UvRegion | null {
  const { bandOffsets, bandLengths, bandStepLog2s } = layout;
  if (!(numFrames > 0) || !(numBands > 0) || bandOffsets.length === 0) return null;

  let minFrame = Infinity;
  let maxFrame = -Infinity;
  let minBand = Infinity;
  let maxBand = -Infinity;

  for (let r = 0; r + 1 < ranges.length; r += 2) {
    let index = ranges[r];
    const end = ranges[r] + ranges[r + 1];

    // Last band whose offset is at or below the range start.
    let lo = 0;
    let hi = bandOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bandOffsets[mid] <= index) lo = mid;
      else hi = mid - 1;
    }

    for (let band = lo; band < bandOffsets.length && index < end; band++) {
      const bandStart = bandOffsets[band];
      const bandEnd = bandStart + bandLengths[band];
      const spanStart = Math.max(index, bandStart);
      const spanEnd = Math.min(end, bandEnd);
      if (spanEnd > spanStart) {
        const frameSpan = Math.pow(2, bandStepLog2s[band]);
        const firstFrame = (spanStart - bandStart) * frameSpan;
        const lastFrame = (spanEnd - bandStart) * frameSpan;
        if (firstFrame < minFrame) minFrame = firstFrame;
        if (lastFrame > maxFrame) maxFrame = lastFrame;
        if (band < minBand) minBand = band;
        if (band > maxBand) maxBand = band;
      }
      index = bandEnd;
    }
  }

  if (!(maxFrame > minFrame) || minBand > maxBand) return null;
  return {
    startX: Math.max(0, minFrame / numFrames),
    endX: Math.min(1, maxFrame / numFrames),
    startY: 1 - (maxBand + 1) / numBands,
    endY: 1 - minBand / numBands,
  };
}

export class HistoryManager {
  private readonly fileId: string;
  private readonly dir: Promise<string>;
  private manifest: HistoryManifest | null = null;
  private initPromise: Promise<void> | null = null;
  private currentPacked: Float32Array | null = null;
  private audioLru: string[] = [];
  // On-disk size of each cached render, for the audio LRU's byte budget.
  private audioBytes = new Map<string, number>();
  // ID of the full-snapshot node whose spectrogramData (inverseMap, metadata,
  // dimensions) currently reflects on the file. Used to avoid a redundant
  // reloadTextures() when navigating among nodes that share an anchor — which
  // is the common case for undo/redo within a single analysis.
  private lastLoadedAnchorId: string | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private manifestWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private manifestWritePending = false;
  private readonly packedCache: PackedStateCache;
  // Dirty ranges of strokes added this session, keyed by node id. Lets
  // navigation between such nodes upload only the changed texture rows
  // instead of the whole packed state. Purely an optimization: a miss falls
  // back to the full upload.
  private readonly nodeDirtyRanges = new Map<string, Uint32Array>();
  private readonly nodeAudioRegions = new Map<string, UvRegion>();
  // Each stroke's encoded coefficient delta against its parent, kept this
  // session so a hop in either direction is one pass over the current state
  // rather than a rebuild from the nearest snapshot on disk.
  private readonly nodeDeltas: ByteBudgetCache<Uint8Array>;
  // The audio each stroke rewrote, before and after, so a hop restores the
  // audio the state had rather than synthesising it again.
  private readonly nodeAudioHops: ByteBudgetCache<AudioHop>;
  // The phase turns each stroke made past its ranges; null for a stroke that
  // made none. A node absent here is read back from its delta on disk.
  private readonly nodeTurns = new Map<string, PhaseTurns | null>();
  // True when the renderer's FBO no longer matches currentId's packed state
  // (e.g. restore-original bypasses history); forces the next navigation to
  // upload the full state rather than a patch.
  private fboOutOfSync = false;
  // The onset restore still reading currentPacked, if any.
  private onsetRestore: Promise<void> | null = null;

  constructor(fileId: string, options: { packedCacheBytes?: number } = {}) {
    this.fileId = fileId;
    const budgets = historyCacheBudgets(host.os.totalmem());
    this.packedCache = new PackedStateCache(options.packedCacheBytes ?? budgets.packedStates);
    this.nodeDeltas = new ByteBudgetCache<Uint8Array>(budgets.deltas, (bytes) => bytes.byteLength);
    this.nodeAudioHops = new ByteBudgetCache<AudioHop>(budgets.audioHops, audioHopBytes);
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
      void this.flushManifestWrite();
    }, MANIFEST_WRITE_DEBOUNCE_MS);
  }

  /** Resolves once the pending debounced write has reached disk. */
  private flushManifestWrite(): Promise<void> {
    if (this.manifestWriteTimer != null) {
      clearTimeout(this.manifestWriteTimer);
      this.manifestWriteTimer = null;
    }
    if (!this.manifestWritePending) return Promise.resolve();
    this.manifestWritePending = false;
    return this.writeManifest();
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

  /** The id of the node the file sits on now. Null until the history loads. */
  async currentNodeId(): Promise<string | null> {
    await this.initialize();
    return this.manifest?.currentId ?? null;
  }

  // Record that a node's audio has been written to disk, so it becomes the
  // clean reference for the dirty flag. Defaults to the current node.
  async markSaved(nodeId?: string): Promise<void> {
    await this.initialize();
    if (!this.manifest) return;
    this.manifest.savedNodeId = nodeId ?? this.manifest.currentId;
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
  // WavPack rather than WAV: lossless for float samples, roughly a quarter
  // smaller, and ffmpeg both ends of the trip.
  private audioPath(dir: string, nodeId: string): string {
    return host.path.join(dir, `${nodeId}.wv`);
  }
  private onsetsPath(dir: string, nodeId: string): string {
    return host.path.join(dir, `${nodeId}.onsets.zst`);
  }

  // Every file a node can own on disk, for the paths that delete one.
  private nodeFilePaths(dir: string, nodeId: string): string[] {
    return [
      this.packedPath(dir, nodeId),
      this.deltaPath(dir, nodeId),
      this.audioPath(dir, nodeId),
      this.onsetsPath(dir, nodeId),
    ];
  }

  /**
   * Onsets belong to the coefficients they were found in, so each state keeps
   * its own: moving through the tree restores the onsets of the state arrived
   * at, and reopening a file reads them back rather than walking every
   * coefficient again, which on a long file takes seconds. A few hundred bytes
   * to a few kilobytes each, so unlike the audio cache they are never evicted.
   */
  async setNodeOnsets(nodeId: string, packedState: Float32Array): Promise<void> {
    await this.initialize();
    const node = this.manifest?.nodes[nodeId];
    if (!node) return;
    const dir = await this.ensureDir();
    await writeFloat32Compressed(this.onsetsPath(dir, nodeId), packedState);
    if (!node.onsetsCached) {
      node.onsetsCached = true;
      this.scheduleManifestWrite();
    }
  }

  /** Null when the node predates onset storage, or its file has gone. */
  async getNodeOnsets(nodeId: string): Promise<Float32Array | null> {
    await this.initialize();
    const node = this.manifest?.nodes[nodeId];
    if (!node?.onsetsCached) return null;
    try {
      const dir = await this.dir;
      return await readFloat32Compressed(this.onsetsPath(dir, nodeId));
    } catch {
      node.onsetsCached = false;
      return null;
    }
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
      synthesisMetadata: synthesisMetadataFromSpectrogram(opts.spectrogram),
    };
    this.manifest = { version: HISTORY_MANIFEST_VERSION, rootId: id, currentId: id, nodes: { [id]: node } };
    await this.writeFullSnapshot(id, opts.data);
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
      synthesisMetadata: synthesisMetadataFromSpectrogram(opts.spectrogram),
    };

    await this.writeFullSnapshot(id, opts.data);
    if (!this.manifest) return id;

    this.linkChild(parentId, id);
    this.manifest.nodes[id] = node;
    this.manifest.currentId = id;
    this.currentPacked = new Float32Array(opts.data);
    this.packedCache.set(id, this.currentPacked);
    this.lastLoadedAnchorId = id;
    this.fboOutOfSync = false;
    // The packed layout changes with the new dimensions, so a patch stashed
    // against the old one no longer addresses the pixels it was cut from.
    clearCanvasPatchStash(this.fileId);
    await this.writeManifest();
    this.notifyStateChange();
    return id;
  }

  /**
   * Append a stroke as a child of the current node. Stored as a footprint delta
   * when dimensions match and the brush footprint is known and covers less than
   * half the texture, otherwise as a full packed snapshot.
   */
  async addStroke(opts: AddStrokeOpts): Promise<AddStrokeOutcome> {
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
    // A stroke written into the current state in place compares against the
    // footprint values it saved; any other compares against the whole base.
    const compact = opts.baseFootprint;
    const deltaBase = compact ?? base;

    let storage: "delta" | "packed";
    let deltaBytes: Uint8Array | undefined;
    let rangesForPatch: Uint32Array | null = null;

    if (
      sameDims &&
      deltaBase != null &&
      (compact ? compact.length === footprintPixels * 4 : deltaBase.length === opts.data.length) &&
      ranges != null &&
      ranges.length > 0 &&
      footprintPixels < texturePixels * 0.5
    ) {
      const deltaStart = performance.now();
      if (!(await host.analysis.historyFootprintChanged(deltaBase, opts.data, ranges, compact != null))) {
        // The stroke changed nothing, so it gets no node of its own. The
        // caller must not then write its audio against the parent's id. The
        // canvas is still the parent's, so its projection state is too.
        const file = openFiles[this.fileId];
        if (file) file.unprojectedPaint = parent.unprojectedPaint === true;
        return { id: parentId, isNew: false };
      }
      rangesForPatch = ranges;
      // A checkpoint is stored whole on disk, but its delta still carries the
      // hops to and from it in memory.
      deltaBytes = await host.analysis.encodeHistoryDelta(
        deltaBase,
        opts.data,
        ranges,
        compact != null,
        hasPhaseTurns(opts.turns) ? opts.turns : undefined,
      );
      storage = this.deltaStepsSinceLastSnap(parentId) >= CHECKPOINT_INTERVAL ? "packed" : "delta";
      diag.timing("timing", "addStroke footprint delta", performance.now() - deltaStart, {
        ranges: ranges.length / 2,
        footprintPixels,
      });
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
    if (opts.unprojectedPaint) node.unprojectedPaint = true;

    const dir = await this.ensureDir();
    if (storage === "delta" && deltaBytes) {
      await host.fs.writeFile(this.deltaPath(dir, id), Buffer.from(deltaBytes));
    } else {
      await writePackedCompressed(this.packedPath(dir, id), opts.data);
    }

    // Closing the file purges the manifest while the delta encoding and the
    // node write above are still running; there is no tree left to append to.
    if (!this.manifest) return { id: parentId, isNew: false };

    this.linkChild(parentId, id);
    this.manifest.nodes[id] = node;
    this.manifest.currentId = id;
    // opts.data is either a fresh readback or the current state written in
    // place; either way it now holds this node and no other.
    this.currentPacked = opts.data;
    this.packedCache.deleteValue(opts.data);
    this.packedCache.set(id, this.currentPacked);
    if (rangesForPatch) this.nodeDirtyRanges.set(id, rangesForPatch);
    if (deltaBytes) {
      this.nodeDeltas.set(id, deltaBytes);
      this.nodeTurns.set(id, hasPhaseTurns(opts.turns) ? opts.turns : null);
    }
    if (opts.audioRegion) this.nodeAudioRegions.set(id, opts.audioRegion);
    // The stroke was read back from the FBO, so the two are in step again.
    this.fboOutOfSync = false;
    await this.writeManifest();
    this.notifyStateChange();
    return { id, isNew: true };
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

  private async writeFullSnapshot(nodeId: string, packed: Float32Array): Promise<void> {
    const dir = await this.ensureDir();
    await writePackedCompressed(this.packedPath(dir, nodeId), packed);
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
    let packed = await readPackedCompressed(this.packedPath(dir, anchor.id));

    for (let i = 1; i < chain.length; i++) {
      const n = chain[i];
      if (n.storage === "delta") {
        const buf = await host.fs.readFile(this.deltaPath(dir, n.id));
        packed = await host.analysis.applyHistoryDelta(
          packed,
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        );
      } else if (n.storage === "packed") {
        packed = await readPackedCompressed(this.packedPath(dir, n.id));
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
    // data once, then applies deltas forward. We piggyback on that walk to know
    // the anchor identity, and rebuild its side data (inverseMap + metadata) —
    // which reconstruct doesn't need but spectrogramData does.
    const { packedData, fullAnchor } = await this.reconstruct(targetId);
    if (!fullAnchor || !fullAnchor.synthesisMetadata) return null;

    const { inverseMap, metadata } = await deriveSideData(fullAnchor);
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
    const reopened = openFiles[this.fileId];
    if (reopened) reopened.unprojectedPaint = target.unprojectedPaint === true;
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
    void synthesizeFile(this.fileId, undefined, this.currentPacked ?? undefined);
  }

  // ---------- Navigation ----------

  /**
   * Navigate to an arbitrary node. Restores the FBO data and the spectrogramData if the
   * target lineage crosses a full snapshot. Updates lastChildId along the path.
   * Caller should await this; audio is restored from cached WAV if present, else synthesised.
   */
  async navigateTo(targetId: string): Promise<void> {
    // Queued against stroke commits and against other navigations: both derive
    // their result from currentId/currentPacked and then replace them, so the
    // one that finishes last would otherwise win regardless of which was asked
    // for last.
    return serializeFileTask(this.fileId, () => this.navigateToNow(targetId));
  }

  private async navigateToNow(targetId: string): Promise<void> {
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

    // A hop walks the current packed state in place, so whatever still reads
    // it — a synthesis it was handed, an onset pass — has to land first.
    await this.awaitPackedReaders();
    if (!this.manifest || !openFiles[this.fileId]?.rendererRef?.current) return;
    const fromId = this.manifest.currentId;

    // Reuse the cached canonical packed state when we've recently visited the
    // target (the common undo/redo case) — it's the exact array that was last on
    // screen, so round-trips are lossless and need no disk read / decompress /
    // delta replay. On a miss, walk the hops' deltas over the current state,
    // and failing that rebuild from the nearest checkpoint on disk.
    let packedData = this.packedCache.get(targetId);
    if (!packedData) {
      packedData = (await this.reconstructByHops(fromId, targetId)) ?? (await this.reconstruct(targetId)).packedData;
      // Closing the file purges the manifest and the on-disk tree; the
      // reconstruction that was already running has nothing left to restore to.
      if (!this.manifest || !openFiles[this.fileId]?.rendererRef?.current) return;
    }

    // Only rebuild textures and swap spectrogramData when the full-snapshot
    // anchor has actually changed (i.e. we crossed a resize/reanalyze boundary).
    // For typical undo/redo within a single analysis, the file's existing
    // inverseMap/metadata/dims are still correct — just push the new FBO bytes.
    const anchor = this.nearestFullAnchor(targetId);
    let hopRegion: UvRegion | null = null;
    if (anchor && anchor.id !== this.lastLoadedAnchorId) {
      await this.restoreSpectrogramFromFull(anchor, packedData);
      if (!this.manifest || !openFiles[this.fileId]?.rendererRef?.current) return;
      this.lastLoadedAnchorId = anchor.id;
    } else {
      // When every hop between here and the target is a stroke whose dirty
      // ranges are known, only those texture rows differ from what the FBO
      // already holds — upload just them. A commit's patch still waiting in
      // the stash names pixels the FBO also misses, so they go in the same
      // upload.
      let ranges = this.fboOutOfSync ? null : this.pathDirtyRanges(fromId, targetId);
      const stash = takeCanvasPatchStash(this.fileId);
      if (ranges && stash) ranges = mergePixelRanges(ranges, stash.ranges);
      // Each hop's phase turns go on the canvas as operations, in walking
      // order, with the stash's first; the pixels an undone turn cannot
      // subtract back exactly come with the patch.
      const turns = ranges ? await this.pathTurns(fromId, targetId) : null;
      if (!turns) ranges = null;
      if (ranges && turns) {
        for (const stashed of stash?.turns ?? []) turns.unshift({ turns: stashed, invert: false });
        for (const turn of turns) {
          if (turn.invert) ranges = mergePixelRanges(ranges, phaseTurnResidualRanges(turn.turns));
        }
      }
      const restoreStart = performance.now();
      if (ranges && turns) {
        // The patch writes its pixels from the state afterwards, so the turns
        // leave them out.
        if (turns.length) await applyCanvasTurns(file.rendererRef.current, packedData, turns, ranges);
        if (!this.manifest || !openFiles[this.fileId]?.rendererRef?.current) return;
        file.rendererRef.current.patchFBOData(packedData, ranges);
        if (file.spectrogramData) {
          hopRegion =
            this.pathAudioRegion(this.manifest.currentId, targetId) ??
            packedRangesToUvRegion(
              ranges,
              file.spectrogramData.synthesisMetadata,
              file.spectrogramData.numFrames,
              file.spectrogramData.numBands,
            );
        }
      } else {
        file.rendererRef.current.setFBOData(packedData);
      }
      diag.timing("timing", "navigateTo FBO upload", performance.now() - restoreStart, {
        mode: ranges ? "patch" : "full",
      });
    }
    this.fboOutOfSync = false;
    // The FBO now holds the target state; a patch stashed against the old
    // state would write stale pixels onto it.
    clearCanvasPatchStash(this.fileId);

    this.manifest.currentId = targetId;
    // The coefficients on the canvas are this node's, so whether they hold
    // unprojected paint is its answer too — the next re-analysing stroke reads
    // it to decide whether it settles the whole file.
    file.unprojectedPaint = target.unprojectedPaint === true;
    // packedData is a cache entry, a fresh rebuild, or the current array walked
    // in place — which then no longer holds the node it was cached under.
    this.currentPacked = packedData;
    this.packedCache.deleteValue(packedData, targetId);
    this.packedCache.set(targetId, packedData);
    this.scheduleManifestWrite();
    this.notifyStateChange();

    // Onsets describe the coefficients they were found in, so they move with
    // the state. Not awaited: the picture is already back, and the markers and
    // the onset grid can follow a moment later.
    this.onsetRestore = useStore.getState().restoreOnsetsForNode(this.fileId, targetId, packedData);

    // Every hop that kept the audio it rewrote puts it straight back, so the
    // state's audio returns exactly — limiting and all — without a synthesis.
    if (await this.restoreAudioByHops(fromId, targetId)) return;

    // When the hops' dirty region is known and a buffer exists, only that
    // window's audio differs between the two states, so only it is
    // synthesized and spliced.
    if (hopRegion && file.audioBuffer) {
      file.rendererRef.current.expandDirtyRegion(hopRegion.startX, hopRegion.endX, hopRegion.startY, hopRegion.endY);
      // packedData is the state the FBO was just set to, so passing it skips
      // the full FBO readback.
      const { synthesizeFile } = useStore.getState();
      void synthesizeFile(this.fileId, undefined, packedData);
      return;
    }
    // Cached render if present, otherwise re-synthesize in full.
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
    void synthesizeFile(this.fileId, undefined, packedData);
  }

  /**
   * Marks the renderer's FBO as diverged from the history's current node
   * (e.g. after restore-original, which bypasses history). The next
   * navigation then uploads the full packed state instead of a patch. Any
   * stashed canvas patch described the diverged state, so it goes too.
   */
  markFboOutOfSync(): void {
    this.fboOutOfSync = true;
    clearCanvasPatchStash(this.fileId);
  }

  /**
   * The packed state of the current node. Commits write their footprint into
   * it in place and hops walk it in place, so it only changes between the
   * file's queued tasks, and only after {@link awaitPackedReaders}.
   */
  currentPackedState(): Float32Array | null {
    return this.currentPacked;
  }

  /**
   * Resolves once nothing outside the queue still reads the current packed
   * state: a synthesis it was handed, or an onset pass over it.
   */
  async awaitPackedReaders(): Promise<void> {
    await awaitFileSynthesis(this.fileId);
    if (this.onsetRestore) {
      try {
        await this.onsetRestore;
      } catch {
        // The restore reports its own failure.
      }
    }
  }

  /**
   * The hops from one state to another, in walking order: `up` climbs from
   * `fromId` to the child of the common ancestor, `down` descends from the
   * ancestor's other child to `toId`. Each id stands for the change its node
   * made on its parent. Null when the nodes do not share a root, or are the
   * same node.
   */
  private hopsBetween(fromId: string, toId: string): { up: string[]; down: string[] } | null {
    if (!this.manifest) return null;
    // Same-node navigation can't be trusted as a no-op: deleteNode reassigns
    // currentId before navigating, so the FBO may hold a deleted state.
    if (fromId === toId) return null;

    const fromAncestors = new Set<string>();
    let cursor: string | null = fromId;
    while (cursor) {
      fromAncestors.add(cursor);
      cursor = this.manifest.nodes[cursor]?.parentId ?? null;
    }

    const down: string[] = [];
    cursor = toId;
    while (cursor && !fromAncestors.has(cursor)) {
      down.push(cursor);
      cursor = this.manifest.nodes[cursor]?.parentId ?? null;
    }
    if (!cursor) return null;
    const lca = cursor;
    const up: string[] = [];
    cursor = fromId;
    while (cursor && cursor !== lca) {
      up.push(cursor);
      cursor = this.manifest.nodes[cursor]?.parentId ?? null;
    }
    down.reverse();
    return { up, down };
  }

  /**
   * The phase turns of every hop between two states, in walking order and
   * signed for it, or null when any hop's are unknown.
   */
  private async pathTurns(fromId: string, toId: string): Promise<CanvasTurn[] | null> {
    const hops = this.hopsBetween(fromId, toId);
    if (!hops) return null;
    const out: CanvasTurn[] = [];
    for (const [ids, invert] of [
      [hops.up, true],
      [hops.down, false],
    ] as const) {
      for (const id of ids) {
        const turns = await this.nodeTurnsOf(id);
        if (turns === undefined) return null;
        if (turns) out.push({ turns, invert });
      }
    }
    return out;
  }

  /** A node's phase turns: null when it made none, undefined when unknown. */
  private async nodeTurnsOf(id: string): Promise<PhaseTurns | null | undefined> {
    if (this.nodeTurns.has(id)) return this.nodeTurns.get(id);
    const bytes = await this.nodeDelta(id);
    if (!bytes) return undefined;
    try {
      const turns = await host.analysis.readHistoryDeltaTurns(bytes);
      const kept = hasPhaseTurns(turns) ? turns : null;
      this.nodeTurns.set(id, kept);
      return kept;
    } catch {
      return undefined;
    }
  }

  /**
   * The coefficient delta a node made on its parent: kept from this session,
   * or read back from disk for a stroke stored as one. Null for a node stored
   * whole, whose hop is a rebuild.
   */
  private async nodeDelta(id: string): Promise<Uint8Array | null> {
    const kept = this.nodeDeltas.get(id);
    if (kept) return kept;
    const node = this.manifest?.nodes[id];
    if (!node || node.storage !== "delta") return null;
    try {
      const dir = await this.dir;
      const buf = await host.fs.readFile(this.deltaPath(dir, id));
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      this.nodeDeltas.set(id, bytes);
      return bytes;
    } catch {
      return null;
    }
  }

  /**
   * Builds the target state from the current one by walking the hops'
   * deltas — subtracted going up, added going down — in one pass over the
   * packed array. Null when a hop has no delta, which leaves the rebuild from
   * the nearest snapshot on disk.
   */
  private async reconstructByHops(fromId: string, toId: string): Promise<Float32Array | null> {
    const base = this.currentPacked;
    const hops = this.hopsBetween(fromId, toId);
    if (!base || !hops) return null;
    const ids = [...hops.up, ...hops.down];
    if (!ids.length) return null;
    const deltas: Uint8Array[] = [];
    for (const id of ids) {
      const bytes = await this.nodeDelta(id);
      if (!bytes) return null;
      deltas.push(bytes);
    }
    if (!this.manifest) return null;
    const inverts = ids.map((_, i) => i < hops.up.length);
    const start = performance.now();
    try {
      // Walked in place: the array stops being `fromId`'s state and becomes
      // the target's, which the caller records in the cache.
      const packed = await host.analysis.applyHistoryDeltas(base, base, deltas, inverts);
      diag.timing("timing", "navigateTo delta hops", performance.now() - start, { hops: ids.length });
      return packed;
    } catch (error) {
      console.error("history: walking the stroke deltas failed", error);
      return null;
    }
  }

  /** Keeps the audio a stroke rewrote, so hops over it restore rather than synthesise. */
  setNodeAudioHop(nodeId: string, hop: AudioHop): void {
    this.nodeAudioHops.set(nodeId, hop);
  }

  /**
   * Writes the audio of the target state back from the hops' kept windows.
   * False when a hop has none, which leaves the audio to synthesis.
   */
  private async restoreAudioByHops(fromId: string, toId: string): Promise<boolean> {
    const hops = this.hopsBetween(fromId, toId);
    if (!hops) return false;
    const up: AudioHop[] = [];
    const down: AudioHop[] = [];
    for (const id of hops.up) {
      const hop = this.nodeAudioHops.get(id);
      if (!hop) return false;
      up.push(hop);
    }
    for (const id of hops.down) {
      const hop = this.nodeAudioHops.get(id);
      if (!hop) return false;
      down.push(hop);
    }
    const walk = editsAlongHops(up, down);
    if (!walk) return false;
    const start = performance.now();
    const applied = await useStore.getState().spliceFileAudio(this.fileId, walk.edits, walk.meta);
    if (applied) {
      diag.timing("timing", "navigateTo audio hops", performance.now() - start, { hops: walk.edits.length });
    }
    return applied;
  }

  /**
   * Union of the per-node dirty ranges along the tree path between two nodes,
   * or null when any hop's ranges are unknown (nodes from a previous session,
   * checkpoints of oversized footprints) — callers then fall back to a full
   * upload. Every node on the path except the common ancestor stands for the
   * delta its hop crosses, in either direction.
   */
  private pathDirtyRanges(fromId: string, toId: string): Uint32Array | null {
    const path = this.pathBetween(fromId, toId);
    if (!path) return null;
    let ranges: Uint32Array = new Uint32Array(0);
    for (const id of path) {
      const r = this.nodeDirtyRanges.get(id);
      if (!r) return null;
      ranges = mergePixelRanges(ranges, r);
    }
    return ranges;
  }

  /**
   * Union of the per-node audio regions along the tree path between two nodes,
   * or null when any hop's region is unknown — callers then take the audio
   * window from the full dirty ranges instead.
   */
  private pathAudioRegion(fromId: string, toId: string): UvRegion | null {
    const path = this.pathBetween(fromId, toId);
    if (!path) return null;
    let union: UvRegion | null = null;
    for (const id of path) {
      const r = this.nodeAudioRegions.get(id);
      if (!r) return null;
      union = union
        ? {
            startX: Math.min(union.startX, r.startX),
            endX: Math.max(union.endX, r.endX),
            startY: Math.min(union.startY, r.startY),
            endY: Math.max(union.endY, r.endY),
          }
        : r;
    }
    return union;
  }

  /**
   * The nodes standing between two states: every node on the tree path except
   * the common ancestor, each representing the delta its hop crosses, in
   * either direction. Null when the nodes do not share a root.
   */
  private pathBetween(fromId: string, toId: string): string[] | null {
    const hops = this.hopsBetween(fromId, toId);
    return hops ? [...hops.down, ...hops.up] : null;
  }

  // Both resolve their target inside the queue rather than at the call: a
  // second undo pressed before the first has run must step back from where
  // that one lands, not from the node they were both asked at.
  async navigateToParent(): Promise<void> {
    return serializeFileTask(this.fileId, async () => {
      await this.initialize();
      const id = this.manifest?.nodes[this.manifest.currentId]?.parentId;
      if (id) await this.navigateToNow(id);
    });
  }

  async navigateToLastChild(): Promise<void> {
    return serializeFileTask(this.fileId, async () => {
      await this.initialize();
      const id = this.manifest?.nodes[this.manifest.currentId]?.lastChildId;
      if (id) await this.navigateToNow(id);
    });
  }

  private async restoreSpectrogramFromFull(anchor: HistoryNode, packedData: Float32Array): Promise<void> {
    const file = openFiles[this.fileId];
    if (!file?.rendererRef?.current) return;
    const { inverseMap, metadata } = await deriveSideData(anchor);
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
      await host.analysis.exportAudio(channels, path, audioBuffer.sampleRate, AUDIO_CACHE_FORMAT);
    } catch (err) {
      console.error("history: failed to cache audio", err);
      return;
    }
    node.audioCached = true;
    node.audioPeak = peak;
    try {
      const stat = await host.fs.stat(path);
      this.audioBytes.set(nodeId, Number(stat.size));
    } catch {
      // Size unknown — the count cap still bounds this entry.
    }
    this.touchAudioLru(nodeId);
    await this.enforceAudioLru();
    await this.writeManifest();
    this.emit();
  }

  private touchAudioLru(nodeId: string): void {
    this.audioLru = [nodeId, ...this.audioLru.filter((id) => id !== nodeId)];
  }

  private cachedAudioBytes(): number {
    let total = 0;
    for (const id of this.audioLru) total += this.audioBytes.get(id) ?? 0;
    return total;
  }

  /** Bytes the in-memory caches hold: packed states, node deltas and audio hops. */
  memoryCacheBytes(): { packedStates: number; deltas: number; audioHops: number } {
    return {
      packedStates: this.packedCache.byteCount,
      deltas: this.nodeDeltas.byteCount,
      audioHops: this.nodeAudioHops.byteCount,
    };
  }

  // Bounded by both a count and a byte budget: one cached render of a short file
  // is a couple of megabytes, but of a ten-minute stereo file it is over a
  // hundred, so a count alone lets the cache run to gigabytes.
  private async enforceAudioLru(): Promise<void> {
    if (!this.manifest) return;
    while (
      this.audioLru.length > AUDIO_LRU_CAPACITY ||
      (this.audioLru.length > 1 && this.cachedAudioBytes() > AUDIO_LRU_BYTES)
    ) {
      const evict = this.audioLru.pop();
      if (!evict) break;
      this.audioBytes.delete(evict);
      const node = this.manifest.nodes[evict];
      if (!node || !node.audioCached) continue;
      const dir = await this.dir;
      host.fs.rm(this.audioPath(dir, evict)).catch(() => {});
      node.audioCached = false;
    }
  }

  /**
   * Drop cached audio for every node except the current one, the last-saved one,
   * and any the user favorited. Called when the app is closing: the renders are
   * only a shortcut past re-synthesis, and keeping fifty of them on disk between
   * sessions costs far more than regenerating the one or two that get revisited.
   */
  async pruneAudioCache(): Promise<void> {
    if (!this.manifest) return;
    const keep = new Set<string>([this.manifest.currentId, this.manifest.savedNodeId ?? this.manifest.rootId]);
    const dir = await this.dir;
    let changed = false;
    for (const node of Object.values(this.manifest.nodes)) {
      if (!node.audioCached || keep.has(node.id) || node.favorited) continue;
      await host.fs.rm(this.audioPath(dir, node.id)).catch(() => {});
      node.audioCached = false;
      this.audioBytes.delete(node.id);
      changed = true;
    }
    this.audioLru = this.audioLru.filter((id) => this.manifest?.nodes[id]?.audioCached);
    if (changed) await this.writeManifest();
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
    return serializeFileTask(this.fileId, () => this.deleteSubtreeNow(nodeId));
  }

  private async deleteSubtreeNow(nodeId: string): Promise<void> {
    if (!this.manifest) return;
    const root = this.manifest.nodes[nodeId];
    if (!root || root.id === this.manifest.rootId) return;

    const dir = await this.dir;
    if (!this.manifest) return;
    const toDelete: string[] = [];
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop()!;
      toDelete.push(id);
      const n = this.manifest.nodes[id];
      if (n) stack.push(...n.childIds);
    }

    for (const id of toDelete) {
      for (const f of this.nodeFilePaths(dir, id)) host.fs.rm(f).catch(() => {});
      this.packedCache.delete(id);
      this.audioBytes.delete(id);
      this.nodeDirtyRanges.delete(id);
      this.nodeAudioRegions.delete(id);
      this.nodeDeltas.delete(id);
      this.nodeAudioHops.delete(id);
      this.nodeTurns.delete(id);
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
      await this.navigateToNow(fallback);
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

    // Fast path: transcode the node's cached render rather than synthesizing it
    // again. Still far cheaper than a full re-synthesis, but unlike the WAV
    // cache this replaced, the cached file isn't the export format.
    if (target.audioCached) {
      const dir = await this.dir;
      const cached = this.audioPath(dir, nodeId);
      try {
        const dims = target.dimensions;
        const channels = await host.analysis.decodeAudio(cached, dims.sampleRate, dims.numChannels);
        if (channels.length && channels[0].length) {
          await host.analysis.exportAudio(channels, outputPath, dims.sampleRate, "wav");
          return true;
        }
      } catch {
        // Cached render unusable (evicted or permission issue) — fall through to
        // re-synthesis without mutating the manifest.
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
    return serializeFileTask(this.fileId, () => this.resetToCurrentNow());
  }

  private async resetToCurrentNow(): Promise<void> {
    await this.initialize();
    if (!this.manifest) return;
    const currentId = this.manifest.currentId;
    const current = this.manifest.nodes[currentId];
    if (!current) return;

    // The current state's band layout lives on its nearest full-snapshot
    // ancestor; capture it before the ancestors are deleted below.
    const anchor = this.nearestFullAnchor(currentId);
    if (!anchor?.synthesisMetadata) return;
    const layout = anchor.synthesisMetadata;
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
      for (const f of this.nodeFilePaths(dir, id)) host.fs.rm(f).catch(() => {});
      this.packedCache.delete(id);
      this.audioBytes.delete(id);
      this.nodeDirtyRanges.delete(id);
      this.nodeAudioRegions.delete(id);
    }

    // Rewrite the current node as a standalone full snapshot so it can be the
    // root with no ancestors left to reconstruct from.
    host.fs.rm(this.deltaPath(dir, currentId)).catch(() => {});
    await this.writeFullSnapshot(currentId, packed);
    if (!this.manifest) return;

    current.parentId = null;
    current.childIds = [];
    current.lastChildId = null;
    current.storage = "full";
    current.synthesisMetadata = {
      bandOffsets: [...layout.bandOffsets],
      bandStepLog2s: [...layout.bandStepLog2s],
      bandLengths: [...layout.bandLengths],
      bandFreqs: [...layout.bandFreqs],
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
    this.nodeDirtyRanges.clear();
    this.nodeAudioRegions.clear();
    this.nodeDeltas.clear();
    this.nodeAudioHops.clear();
    this.nodeTurns.clear();
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
    this.nodeDirtyRanges.clear();
    this.nodeAudioRegions.clear();
    this.nodeDeltas.clear();
    this.nodeAudioHops.clear();
    this.nodeTurns.clear();
    this.audioLru = [];
    this.audioBytes.clear();
    this.lastLoadedAnchorId = null;
    this.notifyStateChange();
  }

  /**
   * Drop in-memory state. On-disk history is preserved so it can be rehydrated
   * on the next launch.
   */
  async dispose(): Promise<void> {
    // Awaited, not fired off: the caller signals the main process that quitting
    // may proceed as soon as this resolves, and closing the window tears down
    // the context an unfinished write would still be using.
    await this.flushManifestWrite();
    this.manifest = null;
    this.currentPacked = null;
    this.packedCache.clear();
    this.nodeDirtyRanges.clear();
    this.nodeAudioRegions.clear();
    this.nodeDeltas.clear();
    this.nodeAudioHops.clear();
    this.nodeTurns.clear();
    this.audioLru = [];
    this.audioBytes.clear();
    this.lastLoadedAnchorId = null;
    this.listeners.clear();
  }
}

// Global instances per fileId.
const managers = new Map<string, HistoryManager>();

export function getHistoryManager(fileId: string, options: { packedCacheBytes?: number } = {}): HistoryManager {
  let m = managers.get(fileId);
  if (!m) {
    m = new HistoryManager(fileId, options);
    managers.set(fileId, m);
  }
  return m;
}

/** In-memory history cache bytes summed over every open file. */
export function historyMemoryCacheBytes(): { packedStates: number; deltas: number; audioHops: number } {
  const total = { packedStates: 0, deltas: 0, audioHops: 0 };
  for (const manager of managers.values()) {
    const bytes = manager.memoryCacheBytes();
    total.packedStates += bytes.packedStates;
    total.deltas += bytes.deltas;
    total.audioHops += bytes.audioHops;
  }
  return total;
}

/**
 * Called when the user closes a file tab — deletes on-disk history permanently.
 */
export async function destroyHistoryManager(fileId: string): Promise<void> {
  const m = managers.get(fileId);
  if (!m) return;
  await m.purge();
  managers.delete(fileId);
  clearCanvasPatchStash(fileId);
  clearFileTaskQueue(fileId);
}

/**
 * Called on app quit — thins each tree's cached audio down to the states worth
 * keeping, then drops in-memory state. On-disk history is preserved.
 */
export async function clearAllHistoryManagers(): Promise<void> {
  const open = [...managers.values()];
  const openIds = [...managers.keys()];
  managers.clear();
  // A stroke commit or a navigation still on the queue owns the manifest and the
  // node it is writing; disposing under it leaves the tree on disk half-written.
  // Main's quit timeout is the backstop if one of them never settles.
  await drainFileTaskQueues();
  await Promise.all(openIds.map((fileId) => awaitFileSynthesis(fileId)));
  await Promise.all(
    open.map(async (m) => {
      try {
        await m.pruneAudioCache();
      } catch (err) {
        console.error("history: pruning cached audio failed", err);
      }
      await m.dispose();
    }),
  );
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
