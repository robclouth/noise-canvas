import { useStore } from "@renderer/store";
import { awaitFileSynthesis, openFiles } from "@renderer/store/files";
import type { SpectrogramData } from "@renderer/store/types";
import { isManagedFilePath } from "@renderer/store/managed-path";
import type { PhaseTurns } from "../../../main/lib/types";
import { hasPhaseTurns, phaseTurnRanges, phaseTurnResidualRanges } from "../../../main/lib/history-delta";
import { audioHopBytes, editsAlongHops, type AudioHop } from "./audio-hop";
import { bandLayoutOf, bandLengthsTexels } from "./band-layout";
import { blockGrid } from "./block-grid";
import { needsCanvasWindow } from "./canvas-window";
import { canvasWindowBlocks } from "./gpu-budget";
import type { BlockStore } from "./block-store";
import {
  blockStoreDirectory,
  destroyBlockStore,
  getBlockStore,
  openBlockStore,
  releaseBlockStores,
} from "./block-stores";
import { packedTextureSizeOf } from "./canvas-view";
import { applyCanvasTurns, type CanvasTurn } from "./canvas-phase-turns";
import { clearCanvasPatchStash, takeCanvasPatchStash } from "./canvas-patch-stash";
import { diag } from "./diag-log";
import { clearFileTaskQueue, drainFileTaskQueues, serializeFileTask } from "./file-task-queue";
import { historyCacheBudgets } from "./history-cache-budgets";
import { ByteBudgetCache } from "./byte-budget-cache";
import { host } from "./host";
import { copyCompactOverlap, gatherPixelRanges, mergePixelRanges, pixelRangeCount } from "./pixel-ranges";

const MANIFEST_FILENAME = "tree.json";
const CHECKPOINT_INTERVAL = 20;
const AUDIO_LRU_CAPACITY = 50;
const AUDIO_LRU_BYTES = 512 * 1024 * 1024;
// WavPack: lossless for the float samples synthesis produces, and about a
// quarter smaller than the float32 WAV it replaces.
const AUDIO_CACHE_FORMAT = "wv";
const MANIFEST_WRITE_DEBOUNCE_MS = 400;

export type HistoryNodeKind = "root" | "stroke" | "resize" | "reanalyze" | "checkpoint";

export interface HistoryDimensions {
  /** Packed coefficients the state holds: the sum of the band lengths, with no padding. */
  texels: number;
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

/** Dimensions as manifest version 4 wrote them, naming the packed state's texture fold. */
type FoldedDimensions = Omit<HistoryDimensions, "texels"> & { textureWidth: number; textureHeight: number };

type FoldedManifest = Omit<HistoryManifest, "version" | "nodes"> & {
  version: 4;
  nodes: Record<string, Omit<HistoryNode, "dimensions"> & { dimensions: FoldedDimensions }>;
};

function isFoldedManifest(manifest: { version?: number }): manifest is FoldedManifest {
  return manifest.version === 4;
}

/**
 * A version-4 manifest as a current one. The fold was `min(8192, texels)` wide
 * and the arrays were padded to it, so the product is the padded count; the
 * band layout gives the real one.
 */
function migrateFoldedManifest(manifest: FoldedManifest): HistoryManifest {
  const nodes: Record<string, HistoryNode> = {};
  for (const [id, node] of Object.entries(manifest.nodes)) {
    const { textureWidth, textureHeight, ...rest } = node.dimensions;
    const layout = node.synthesisMetadata;
    const texels = layout ? bandLengthsTexels(layout.bandLengths) : textureWidth * textureHeight;
    nodes[id] = { ...node, dimensions: { ...rest, texels } };
  }
  return { ...manifest, version: HISTORY_MANIFEST_VERSION, nodes };
}

/** Whether two nodes' packed states share one analysis grid, texel for texel. */
function sameStoreDimensions(a: HistoryDimensions, b: HistoryDimensions): boolean {
  return (
    a.texels === b.texels &&
    a.numFrames === b.numFrames &&
    a.numBands === b.numBands &&
    a.sampleRate === b.sampleRate &&
    a.minFreq === b.minFreq &&
    a.bandsPerOctave === b.bandsPerOctave
  );
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

const HISTORY_MANIFEST_VERSION = 5;

interface HistoryManifest {
  version: typeof HISTORY_MANIFEST_VERSION;
  rootId: string;
  currentId: string;
  // History node whose audio is currently persisted to disk. The file is dirty
  // exactly when currentId differs from it. Absent on legacy manifests and on
  // never-saved files; both fall back to the root snapshot.
  savedNodeId?: string;
  // History node whose packed state the block store's current tier holds on
  // disk. A patch may build on the tier only when this names the exact state
  // it extends; anything else re-seeds the tier whole. Absent when unknown.
  overlayNodeId?: string;
  // History anchor whose packed state is the block store's seed, so it has no
  // snapshot file of its own. Absent means the root.
  seedNodeId?: string;
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

// --- Helpers ---

function shortId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sameUint32(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
  inverseMap: Float32Array | undefined;
  metadata: Float64Array;
}> {
  const { texels, numFrames, sampleRate } = node.dimensions;
  const layout = node.synthesisMetadata;
  if (!layout) throw new Error(`HistoryManager: node ${node.id} has no band layout`);

  const metadata = bandMetadataOf(node);
  // A canvas holding a window builds its own inverse map from the view, so the
  // file-sized one is not made for it.
  const grid = blockGrid({ numBands: node.dimensions.numBands, metadata }, numFrames, sampleRate);
  if (needsCanvasWindow(grid, canvasWindowBlocks(grid))) return { inverseMap: undefined, metadata };

  // The inverse map has an entry per packed pixel, so the addon fills it; the
  // metadata texture is four floats per band and stays here.
  const inverseMap = await host.analysis.buildHistoryInverseMap(
    new Uint32Array(layout.bandOffsets),
    new Uint32Array(layout.bandLengths),
    new Int32Array(layout.bandStepLog2s),
    texels,
  );

  return { inverseMap, metadata };
}

/** The band layout rows of a node's stored layout. */
function bandMetadataRows(layout: NonNullable<HistoryNode["synthesisMetadata"]>, numBands: number): Float64Array {
  return bandLayoutOf(numBands, layout.bandOffsets, layout.bandLengths, layout.bandStepLog2s, layout.bandFreqs)
    .metadata;
}

/** The band layout rows of a full-snapshot node. */
function bandMetadataOf(node: HistoryNode): Float64Array {
  const layout = node.synthesisMetadata;
  if (!layout) throw new Error(`HistoryManager: node ${node.id} has no band layout`);
  return bandMetadataRows(layout, node.dimensions.numBands);
}

function dimensionsFromSpectrogram(s: SpectrogramData): HistoryDimensions {
  return {
    texels: s.texels,
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
  // The whole painted state. Optional when the stroke's footprint values are
  // given instead; a stroke that must store whole without it is refused.
  data?: Float32Array;
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
  // The values the dirty ranges held before the stroke, laid end to end in
  // range order.
  baseFootprint?: Float32Array;
  // The painted values over the dirty ranges, laid end to end in range order.
  // With `baseFootprint`, lets the stroke commit without any whole state.
  afterFootprint?: Float32Array;
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
  // Serializes manifest writes so an older write cannot land over a newer one.
  private manifestWriting: Promise<void> = Promise.resolve();
  // Tier flushes scheduled behind commits and not yet landed. While any are
  // pending, every manifest write masks the tier marker.
  private tierFlushes = 0;
  private tierFlushing: Promise<void> = Promise.resolve();
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
  // The onset restore still reading the packed state it was handed, if any.
  private onsetRestore: Promise<void> | null = null;

  constructor(fileId: string) {
    this.fileId = fileId;
    const budgets = historyCacheBudgets(host.os.totalmem());
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
      if (isFoldedManifest(parsed)) return migrateFoldedManifest(parsed);
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

  private writeManifest(): Promise<void> {
    // Serialized synchronously so a flush triggered just before dispose() nulls
    // the manifest still persists the captured tree across the awaits below.
    // The tier marker is masked while a tier flush is pending: the disk may
    // only name a tier the overlay fully holds.
    const manifest = this.manifest;
    if (!manifest) return Promise.resolve();
    const json = JSON.stringify(this.tierFlushes > 0 ? { ...manifest, overlayNodeId: undefined } : manifest);
    const run = this.manifestWriting.then(async () => {
      const dir = await this.ensureDir();
      await host.fs.writeFile(host.path.join(dir, MANIFEST_FILENAME), json);
    });
    this.manifestWriting = run.catch(() => undefined);
    return run;
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

  private revisionCounter = 0;

  /** Changes whenever the committed state moves, so another file's window re-reads. */
  get revision(): number {
    return this.revisionCounter;
  }

  /** True when the current node has its audio cached on disk. */
  isCurrentAudioCached(): boolean {
    if (!this.manifest) return false;
    const current = this.manifest.nodes[this.manifest.currentId];
    return current?.audioCached === true;
  }

  private notifyStateChange(): void {
    this.revisionCounter++;
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
  async addRootSnapshot(opts: Omit<AddSnapshotOpts, "data"> & { data: Float32Array | null }): Promise<string> {
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
    this.manifest = {
      version: HISTORY_MANIFEST_VERSION,
      rootId: id,
      currentId: id,
      overlayNodeId: id,
      nodes: { [id]: node },
    };
    // The root's packed state lives as the block store's seed rather than as
    // its own snapshot file, so the state is not written to disk twice.
    const s = opts.spectrogram;
    const store = await openBlockStore(
      this.fileId,
      { numBands: s.numBands, metadata: s.metadata },
      { numFrames: s.numFrames, sampleRate: s.sampleRate, texelCount: s.texels },
    );
    if (opts.data) await store.seed(opts.data);
    else if (!store.isSeeded) throw new Error("HistoryManager: the root state was never written");
    await this.writeManifest();
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

    await this.reshapeStoreTo(node, opts.data);
    if (!this.manifest) return id;

    this.linkChild(parentId, id);
    this.manifest.nodes[id] = node;
    this.manifest.currentId = id;
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
    const sameDims = parent.dimensions.texels === opts.dimensions.texels;

    const ranges = opts.dirtyRanges;
    let footprintPixels = 0;
    if (ranges) for (let r = 1; r < ranges.length; r += 2) footprintPixels += ranges[r];
    const texturePixels = opts.dimensions.texels;
    // A footprint commit compares against the values it saved before the
    // stroke; any other reads them back from the block store's tier.
    const turnsIn = hasPhaseTurns(opts.turns) ? opts.turns : null;

    // The delta's two sides, and the painted footprint values the tier's
    // patch writes. Null when the stroke has to store whole.
    let deltaSides: { base: Float32Array; after: Float32Array; patch: Float32Array } | null = null;
    if (sameDims && ranges != null && ranges.length > 0 && footprintPixels < texturePixels * 0.5) {
      const compact =
        opts.baseFootprint?.length === footprintPixels * 4
          ? opts.baseFootprint
          : opts.data
            ? await this.currentRanges(ranges)
            : null;
      const after =
        opts.afterFootprint?.length === footprintPixels * 4
          ? opts.afterFootprint
          : opts.data
            ? gatherPixelRanges(opts.data, ranges)
            : null;
      if (compact && after) deltaSides = { base: compact, after, patch: after };
    }

    let storage: "delta" | "packed";
    let deltaBytes: Uint8Array | undefined;
    let rangesForPatch: Uint32Array | null = null;
    let tierResiduals: Uint32Array | null = null;

    if (deltaSides != null && ranges != null) {
      const deltaStart = performance.now();
      const { base: deltaBase, after } = deltaSides;
      if (!(await host.analysis.historyFootprintChanged(deltaBase, after, ranges, true, true))) {
        // The stroke changed nothing, so it gets no node of its own. The
        // caller must not then write its audio against the parent's id. The
        // canvas is still the parent's, so its projection state is too.
        const file = openFiles[this.fileId];
        if (file) file.unprojectedPaint = parent.unprojectedPaint === true;
        return { id: parentId, isNew: false };
      }
      // The tier takes the stroke before the delta is cut: its turn walk
      // yields the residuals that make the turns invertible over the store.
      tierResiduals = await this.tierStrokePatch(parentId, ranges, deltaSides.patch, turnsIn, opts.data);
      if (!this.manifest) return { id: parentId, isNew: false };
      if (turnsIn && tierResiduals == null) {
        // Without a tier walk there are no residuals to subtract the turns
        // back exactly, so the stroke stores whole.
        storage = "packed";
      } else {
        if (turnsIn && tierResiduals) turnsIn.residuals = tierResiduals;
        rangesForPatch = ranges;
        // A checkpoint is stored whole on disk, but its delta still carries
        // the hops to and from it in memory.
        deltaBytes = await host.analysis.encodeHistoryDelta(deltaBase, after, ranges, true, true, turnsIn ?? undefined);
        storage = this.deltaStepsSinceLastSnap(parentId) >= CHECKPOINT_INTERVAL ? "packed" : "delta";
        diag.timing("timing", "addStroke footprint delta", performance.now() - deltaStart, {
          ranges: ranges.length / 2,
          footprintPixels,
        });
      }
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
      // A checkpoint after a footprint commit has no whole array of its own;
      // the tier was just patched to this state, so it reads back whole.
      const whole = opts.data ?? (tierResiduals != null ? await this.tierWholeState() : null);
      if (!whole) throw new Error("HistoryManager: the stroke needs the whole state and none was read back");
      await writePackedCompressed(this.packedPath(dir, id), whole);
    }

    // Closing the file purges the manifest while the delta encoding and the
    // node write above are still running; there is no tree left to append to.
    if (!this.manifest) return { id: parentId, isNew: false };

    this.linkChild(parentId, id);
    this.manifest.nodes[id] = node;
    this.manifest.currentId = id;
    if (rangesForPatch) this.nodeDirtyRanges.set(id, rangesForPatch);
    if (deltaBytes) {
      this.nodeDeltas.set(id, deltaBytes);
      this.nodeTurns.set(id, turnsIn);
    }
    if (opts.audioRegion) this.nodeAudioRegions.set(id, opts.audioRegion);
    if (tierResiduals != null) {
      this.manifest.overlayNodeId = id;
    } else if (opts.data) {
      let tierRanges = rangesForPatch;
      if (tierRanges && turnsIn) tierRanges = mergePixelRanges(tierRanges, phaseTurnRanges(turnsIn));
      await this.syncStoreToCurrent(parentId, tierRanges, opts.data);
    }
    if (!this.manifest) return { id, isNew: true };
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

  /**
   * The packed state of the anchor that lives as the block store's seed.
   * Histories written before the store keep it as a snapshot file beside the
   * deltas, so a store that is missing or cut for another grid falls back to
   * that.
   */
  private async readSeedPacked(holder: HistoryNode, dir: string): Promise<Float32Array> {
    try {
      return await (await this.seedBlockStore(holder)).readAllRoot();
    } catch {
      return await readPackedCompressed(this.packedPath(dir, holder.id));
    }
  }

  /** The anchor whose packed state is the block store's seed. */
  private seedHolder(): HistoryNode | null {
    if (!this.manifest) return null;
    return this.manifest.nodes[this.manifest.seedNodeId ?? this.manifest.rootId] ?? null;
  }

  private seedBlockStore(holder: HistoryNode): Promise<BlockStore> {
    const open = getBlockStore(this.fileId);
    if (open) return open;
    const { texels, numFrames, numBands, sampleRate } = holder.dimensions;
    return openBlockStore(
      this.fileId,
      { numBands, metadata: bandMetadataOf(holder) },
      { numFrames, sampleRate, texelCount: texels },
    );
  }

  /**
   * Runs the store's flush behind the commit rather than on it. When the last
   * pending flush lands, the manifest is written with the tier marker
   * unmasked. A failed flush leaves the mask standing, so the disk never
   * names a tier the overlay does not hold; the resident blocks stay the
   * truth and the next flush retries the same dirty set.
   */
  private scheduleTierFlush(store: BlockStore): void {
    this.tierFlushes++;
    this.tierFlushing = store.flush().then(
      async () => {
        this.tierFlushes--;
        if (this.tierFlushes === 0 && this.manifest) await this.writeManifest();
      },
      (error) => {
        console.error("history: block store flush failed", error);
      },
    );
  }

  /** Resolves once every scheduled tier flush and its manifest write have landed. */
  awaitTierFlush(): Promise<void> {
    return this.tierFlushing;
  }

  /**
   * Rebuilds the block store over `node`'s grid with `packed` as its seed.
   * The anchor whose state was the old seed is written out as its own
   * snapshot file first, so every anchor stays reconstructable.
   */
  private async reshapeStoreTo(node: HistoryNode, packed: Float32Array): Promise<void> {
    const manifest = this.manifest;
    const layout = node.synthesisMetadata;
    if (!manifest || !layout) throw new Error(`HistoryManager: node ${node.id} has no band layout`);
    // Pending tier flushes land first, so none of their writes can fire while
    // the store is rebuilt over another grid.
    await this.tierFlushing;
    const holder = this.seedHolder();
    const dir = await this.ensureDir();
    if (holder) {
      const path = this.packedPath(dir, holder.id);
      const demoted = await host.fs.access(path).then(
        () => true,
        () => false,
      );
      if (!demoted) {
        const store = await this.seedBlockStore(holder);
        await writePackedCompressed(path, await store.readAllRoot());
      }
    }
    await destroyBlockStore(this.fileId);
    const dims = node.dimensions;
    const store = await openBlockStore(
      this.fileId,
      { numBands: dims.numBands, metadata: bandMetadataRows(layout, dims.numBands) },
      { numFrames: dims.numFrames, sampleRate: dims.sampleRate, texelCount: dims.texels },
    );
    await store.seed(packed);
    if (this.manifest !== manifest) return;
    manifest.seedNodeId = node.id;
    manifest.overlayNodeId = node.id;
  }

  /**
   * Brings the block store's current tier in step with the current state: a
   * patch over `ranges` when the tier already held the state `baseId` names,
   * a full reseed of the tier from `whole` otherwise. The store keeps the
   * root's grid, so a current state with other dimensions stays out of the
   * tier, which then keeps the node it already held. The tier is a cache of
   * one node's state — when a write fails, the marker goes unknown and the
   * truth stays with the root and the deltas.
   */
  private async syncStoreToCurrent(
    baseId: string,
    ranges: Uint32Array | null,
    whole: Float32Array | null,
    values?: Float32Array,
  ): Promise<void> {
    const manifest = this.manifest;
    if (!manifest) return;
    const holder = this.seedHolder();
    const current = manifest.nodes[manifest.currentId];
    if (!holder || !current || !sameStoreDimensions(holder.dimensions, current.dimensions)) return;
    const patchable = manifest.overlayNodeId === baseId && ranges != null;
    const compact = patchable && ranges ? (values ?? (whole ? gatherPixelRanges(whole, ranges) : null)) : null;
    if (patchable ? compact == null : whole == null) return;
    try {
      const store = await this.seedBlockStore(holder);
      // Invalidated on disk before the tier changes, so a crash mid-write
      // cannot leave a torn tier that still reads as current. With a flush
      // pending, every manifest write is already masked, so the disk says
      // undefined without another write.
      manifest.overlayNodeId = undefined;
      if (this.tierFlushes === 0) await this.writeManifest();
      if (this.manifest !== manifest) return;
      if (patchable && ranges && compact) {
        await store.patch(ranges, compact);
      } else if (whole) {
        await store.seedCurrent(whole);
      }
      this.scheduleTierFlush(store);
      if (this.manifest !== manifest) return;
      manifest.overlayNodeId = manifest.currentId;
    } catch (error) {
      manifest.overlayNodeId = undefined;
      console.error("history: block store current sync failed", error);
    }
  }

  /**
   * Applies a stroke to the tier itself: its footprint ranges are patched
   * from the painted values, and its phase turns walked over the tier's own
   * blocks — the same float arithmetic — collecting the residuals an inverted
   * hop needs. Turns that already carry residuals (an addon-applied tail) must
   * agree with the walk; a disagreement means a stale tier, so its spans are
   * force-patched from the painted state and the stored residuals stand. Null
   * when the tier does not hold the parent state or the write fails; the
   * manifest then keeps the tier unknown and the caller falls back to the
   * plain sync.
   */
  private async tierStrokePatch(
    parentId: string,
    ranges: Uint32Array,
    after: Float32Array,
    turns: PhaseTurns | null,
    data: Float32Array | undefined,
  ): Promise<Uint32Array | null> {
    const manifest = this.manifest;
    if (!manifest || manifest.overlayNodeId !== parentId) return null;
    const holder = this.seedHolder();
    const parent = manifest.nodes[parentId];
    if (!holder || !parent || !sameStoreDimensions(holder.dimensions, parent.dimensions)) return null;
    try {
      const store = await this.seedBlockStore(holder);
      // Invalidated on disk before the tier changes, so a crash mid-write
      // cannot leave a torn tier that still reads as current. With a flush
      // pending, every manifest write is already masked, so the disk says
      // undefined without another write.
      manifest.overlayNodeId = undefined;
      if (this.tierFlushes === 0) await this.writeManifest();
      if (this.manifest !== manifest) return null;
      await store.patch(ranges, after);
      let residuals: Uint32Array = new Uint32Array(0);
      if (turns) {
        residuals = await store.applyTurnsCollecting(turns);
        if (turns.residuals.length > 0 && !sameUint32(residuals, turns.residuals)) {
          console.warn("history: the tier's turn walk disagrees with the stroke's residuals");
          if (!data) return null;
          const spans = phaseTurnRanges(turns);
          await store.patch(spans, gatherPixelRanges(data, spans));
          residuals = turns.residuals;
        }
      }
      this.scheduleTierFlush(store);
      if (this.manifest !== manifest) return null;
      return residuals;
    } catch (error) {
      console.error("history: block store current sync failed", error);
      return null;
    }
  }

  /**
   * The target state's pixels over `spans`, derived by walking the hops'
   * deltas from `fromId` over the tier's own values — bit-pattern arithmetic,
   * so both directions are exact. Null when the tier does not hold the base
   * state or a hop's delta is unknown; callers then rebuild in full.
   */
  private async walkTierValues(fromId: string, targetId: string, spans: Uint32Array): Promise<Float32Array | null> {
    const manifest = this.manifest;
    if (!manifest || manifest.overlayNodeId !== fromId) return null;
    const target = manifest.nodes[targetId];
    const holder = this.seedHolder();
    if (!holder || !target || !sameStoreDimensions(holder.dimensions, target.dimensions)) return null;
    const hops = this.hopsBetween(fromId, targetId);
    if (!hops) return null;
    const ids = [...hops.up, ...hops.down];
    if (!ids.length) return null;
    const deltas: Uint8Array[] = [];
    for (const id of ids) {
      const bytes = await this.nodeDelta(id);
      if (!bytes) return null;
      deltas.push(bytes);
    }
    const inverts = ids.map((_, i) => i < hops.up.length);
    try {
      const store = await this.seedBlockStore(holder);
      const values = await store.readRanges(spans);
      const dims = target.dimensions;
      return await host.analysis.applyHistoryDeltasWindowed(values, spans, deltas, inverts, dims.texels);
    } catch (error) {
      console.warn("history: the tier's delta walk failed", error);
      return null;
    }
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
    let packed =
      anchor.id === (this.manifest.seedNodeId ?? this.manifest.rootId)
        ? await this.readSeedPacked(anchor, dir)
        : await readPackedCompressed(this.packedPath(dir, anchor.id));

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
  nearestFullAnchor(nodeId: string): HistoryNode | null {
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
   */
  async loadSpectrogramAtCurrent(): Promise<SpectrogramData | null> {
    await this.initialize();
    if (!this.manifest) return null;
    const targetId = this.manifest.currentId;
    if (!this.manifest.nodes[targetId]) return null;

    const fullAnchor = this.nearestFullAnchor(targetId);
    if (!fullAnchor || !fullAnchor.synthesisMetadata) return null;

    const { inverseMap, metadata } = await deriveSideData(fullAnchor);
    const dims = fullAnchor.dimensions;
    const grid = blockGrid({ numBands: dims.numBands, metadata }, dims.numFrames, dims.sampleRate);
    const windowed = needsCanvasWindow(grid, canvasWindowBlocks(grid));

    let packedData: Float32Array | undefined;
    if (windowed) {
      const holder = this.seedHolder() ?? fullAnchor;
      const store = await this.seedBlockStore(holder);
      if (this.manifest.overlayNodeId !== targetId || !store.isSeeded) {
        const reconstructed = await this.reconstruct(targetId);
        await store.seedCurrent(reconstructed.packedData);
        if (this.manifest) {
          this.manifest.overlayNodeId = targetId;
          await this.writeManifest();
        }
      }
    } else {
      const reconstructed = await this.reconstruct(targetId);
      packedData = reconstructed.packedData;
    }

    return {
      packedData,
      inverseMap,
      metadata,
      texels: dims.texels,
      numFrames: dims.numFrames,
      numBands: dims.numBands,
      numChannels: dims.numChannels,
      sampleRate: dims.sampleRate,
      minFreq: dims.minFreq,
      bandsPerOctave: dims.bandsPerOctave,
      magnitudeEnergy: dims.magnitudeEnergy,
      packedTextureSize: packedTextureSizeOf(dims.texels),
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
    void synthesizeFile(this.fileId);
  }

  // ---------- Navigation ----------

  /**
   * Navigate to an arbitrary node. Restores the FBO data and the spectrogramData if the
   * target lineage crosses a full snapshot. Updates lastChildId along the path.
   * Caller should await this; audio is restored from cached WAV if present, else synthesised.
   */
  async navigateTo(targetId: string): Promise<void> {
    // Queued against stroke commits and against other navigations: both derive
    // their result from the current state and then replace it, so the one
    // that finishes last would otherwise win regardless of which was asked
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

    // Only rebuild textures and swap spectrogramData when the full-snapshot
    // anchor has actually changed (i.e. we crossed a resize/reanalyze boundary).
    // For typical undo/redo within a single analysis, the file's existing
    // inverseMap/metadata/dims are still correct — just push the new FBO bytes.
    const anchor = this.nearestFullAnchor(targetId);
    let hopRegion: UvRegion | null = null;
    let hopTierRanges: Uint32Array | null = null;
    let hopWalked: Float32Array | null = null;
    let packedData: Float32Array | undefined;

    if (!(anchor && anchor.id !== this.lastLoadedAnchorId)) {
      // When every hop between here and the target is a stroke whose dirty
      // ranges are known, only those texture rows differ from what the FBO
      // already holds — upload just them, from a delta walk over the tier. A
      // commit's patch still waiting in the stash names pixels the FBO also
      // misses, so they go in the same upload.
      let ranges = this.fboOutOfSync ? null : this.pathDirtyRanges(fromId, targetId);
      const stash = ranges ? takeCanvasPatchStash(this.fileId) : null;
      if (ranges && stash) ranges = mergePixelRanges(ranges, stash.ranges);
      // Each hop's phase turns go on the canvas as operations, in walking
      // order, with the stash's first; the pixels an undone turn cannot
      // subtract back exactly come with the patch.
      const turns = ranges ? await this.pathTurns(fromId, targetId) : null;
      if (ranges && turns) {
        for (const stashed of stash?.turns ?? []) turns.unshift({ turns: stashed, invert: false });
        for (const turn of turns) {
          if (turn.invert) ranges = mergePixelRanges(ranges, phaseTurnResidualRanges(turn.turns));
        }
        // The turns change phase outside the uploaded ranges, so the walk and
        // the tier's patch cover their spans as well.
        let spans = ranges;
        for (const turn of turns) spans = mergePixelRanges(spans, phaseTurnRanges(turn.turns));
        hopWalked = await this.walkTierValues(fromId, targetId, spans);
        if (!this.manifest || !openFiles[this.fileId]?.rendererRef?.current) return;
        if (hopWalked) {
          const restoreStart = performance.now();
          hopTierRanges = spans;
          const walked = hopWalked;
          const cut = (r: Uint32Array): Float32Array => {
            const out = new Float32Array(pixelRangeCount(r) * 4);
            copyCompactOverlap(out, r, walked, spans);
            return out;
          };
          // The patch writes its pixels from the state afterwards, so the
          // turns leave them out.
          if (turns.length) await applyCanvasTurns(file.rendererRef.current, cut, turns, ranges);
          if (!this.manifest || !openFiles[this.fileId]?.rendererRef?.current) return;
          file.rendererRef.current.patchFBODataCompact(cut(ranges), ranges);
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
          diag.timing("timing", "navigateTo FBO upload", performance.now() - restoreStart, { mode: "patch" });
        }
      }
    }

    if (!hopWalked) {
      // A dimension change, unknown hops, or a tier that does not hold the
      // base state: rebuild the whole target state from disk and upload it.
      try {
        packedData = (await this.reconstruct(targetId)).packedData;
      } catch (error) {
        // Closing the file deletes the tree under a rebuild already in
        // flight, so its reads failing is the close, not a broken history.
        if (!this.manifest || !openFiles[this.fileId]?.rendererRef?.current) return;
        throw error;
      }
      if (!this.manifest || !openFiles[this.fileId]?.rendererRef?.current) return;
      if (anchor && anchor.id !== this.lastLoadedAnchorId) {
        await this.restoreSpectrogramFromFull(anchor, packedData);
        if (!this.manifest || !openFiles[this.fileId]?.rendererRef?.current) return;
        this.lastLoadedAnchorId = anchor.id;
      } else {
        const restoreStart = performance.now();
        file.rendererRef.current.setFBOData(packedData);
        diag.timing("timing", "navigateTo FBO upload", performance.now() - restoreStart, { mode: "full" });
      }
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
    if (hopTierRanges && hopWalked) {
      await this.syncStoreToCurrent(fromId, hopTierRanges, null, hopWalked);
    } else if (packedData) {
      await this.syncStoreToCurrent(fromId, null, packedData);
    }
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
   * The current node's packed state read back from the block store, or null
   * when the store does not carry it (a stale tier, or a state on another
   * grid). Callers queue this against commits, the way every packed reader
   * queues.
   */
  async currentBlockState(): Promise<Float32Array | null> {
    await this.initialize();
    const manifest = this.manifest;
    if (!manifest || manifest.overlayNodeId !== manifest.currentId) return null;
    return await this.tierWholeState();
  }

  /**
   * The tier's whole state, read without the current-marker check. Only for
   * callers that just wrote the tier themselves and know which node it holds.
   */
  private async tierWholeState(): Promise<Float32Array | null> {
    const holder = this.seedHolder();
    if (!holder) return null;
    try {
      return await (await this.seedBlockStore(holder)).readAll();
    } catch {
      return null;
    }
  }

  /**
   * The named pixels of the current node's packed state, read from the block
   * store, or null when the store does not carry that state. Callers queue
   * this against commits, the way every packed reader queues.
   */
  async currentRanges(ranges: Uint32Array): Promise<Float32Array | null> {
    await this.initialize();
    const manifest = this.manifest;
    if (!manifest || manifest.overlayNodeId !== manifest.currentId) return null;
    const holder = this.seedHolder();
    if (!holder) return null;
    try {
      return await (await this.seedBlockStore(holder)).readRanges(ranges);
    } catch {
      return null;
    }
  }

  /**
   * The named pixels of the file's original packed state — the anchor the
   * block store holds as its seed, which is what the pristine texture holds —
   * or null when the store cannot serve it.
   */
  async rootRanges(ranges: Uint32Array): Promise<Float32Array | null> {
    await this.initialize();
    const holder = this.seedHolder();
    if (!holder) return null;
    try {
      return await (await this.seedBlockStore(holder)).readRootRanges(ranges);
    } catch {
      return null;
    }
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
      texels: dims.texels,
      numFrames: dims.numFrames,
      numBands: dims.numBands,
      numChannels: dims.numChannels,
      sampleRate: dims.sampleRate,
      minFreq: dims.minFreq,
      bandsPerOctave: dims.bandsPerOctave,
      magnitudeEnergy: dims.magnitudeEnergy,
      packedTextureSize: packedTextureSizeOf(dims.texels),
      synthesisMetadata: {
        bandOffsets: new Uint32Array(synthMeta.bandOffsets),
        bandStepLog2s: new Int32Array(synthMeta.bandStepLog2s),
        bandLengths: new Uint32Array(synthMeta.bandLengths),
      },
    };
    file.spectrogramData = spectrogramData;
    file.rendererRef.current.reloadTextures();
    file.rendererRef.current.setFBOData(packedData);
    file.rendererRef.current.releaseAnalysisData();
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

  /** Bytes the in-memory caches hold: node deltas and audio hops. */
  memoryCacheBytes(): { deltas: number; audioHops: number } {
    return {
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
    const dirBytes = async (dir: string): Promise<number> => {
      try {
        const entries = await host.fs.readdir(dir);
        let total = 0;
        for (const entry of entries) {
          try {
            const path = host.path.join(dir, entry);
            const s = await host.fs.stat(path);
            total += s.isDirectory() ? await dirBytes(path) : Number(s.size);
          } catch {
            // ignore
          }
        }
        return total;
      } catch {
        return 0;
      }
    };
    try {
      // The root's packed state lives in the blocks directory, so the file's
      // history weighs both.
      return (await dirBytes(await this.dir)) + (await dirBytes(await blockStoreDirectory(this.fileId)));
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
    const packed = (await this.currentBlockState()) ?? (await this.reconstruct(currentId)).packedData;

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
      this.audioBytes.delete(id);
      this.nodeDirtyRanges.delete(id);
      this.nodeAudioRegions.delete(id);
    }

    // Rewrite the current node as the new root. Its packed state becomes a
    // fresh block store seed, the way the original root's was, so it gains no
    // snapshot file of its own.
    host.fs.rm(this.deltaPath(dir, currentId)).catch(() => {});
    host.fs.rm(this.packedPath(dir, currentId)).catch(() => {});
    // Pending tier flushes land first, so none of their writes can fire while
    // the store is rebuilt over the fresh seed.
    await this.tierFlushing;
    await destroyBlockStore(this.fileId);
    const dims = current.dimensions;
    const store = await openBlockStore(
      this.fileId,
      { numBands: dims.numBands, metadata: bandMetadataRows(layout, dims.numBands) },
      { numFrames: dims.numFrames, sampleRate: dims.sampleRate, texelCount: dims.texels },
    );
    await store.seed(packed);
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
    this.manifest.overlayNodeId = currentId;
    this.manifest.seedNodeId = undefined;
    this.manifest.nodes = { [currentId]: current };
    // savedNodeId is left untouched: purging on-disk history doesn't change
    // whether the current audio matches the last save, so the dirty flag carries
    // over (a now-deleted savedNodeId still reads as "differs from saved").

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
    // Queued manifest writes land before the wipe and none start after it,
    // so a late write cannot resurrect the tree file in a deleted directory.
    this.manifest = null;
    await this.tierFlushing;
    await this.manifestWriting;
    const dir = await this.dir;
    try {
      await host.fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
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
    // the context an unfinished write would still be using. The tier flushes
    // settle too, so the manifest on disk names the tier the overlay holds.
    await this.flushManifestWrite();
    await this.tierFlushing;
    this.manifest = null;
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

export function getHistoryManager(fileId: string): HistoryManager {
  let m = managers.get(fileId);
  if (!m) {
    m = new HistoryManager(fileId);
    managers.set(fileId, m);
  }
  return m;
}

/** In-memory history cache bytes summed over every open file. */
export function historyMemoryCacheBytes(): { deltas: number; audioHops: number } {
  const total = { deltas: 0, audioHops: 0 };
  for (const manager of managers.values()) {
    const bytes = manager.memoryCacheBytes();
    total.deltas += bytes.deltas;
    total.audioHops += bytes.audioHops;
  }
  return total;
}

/**
 * Called when the user closes a file tab — deletes on-disk history permanently.
 */
export async function destroyHistoryManager(fileId: string): Promise<void> {
  await destroyBlockStore(fileId);
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
  const blocksReleased = releaseBlockStores();
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
  await blocksReleased;
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
