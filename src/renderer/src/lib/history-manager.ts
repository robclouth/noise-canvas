import { Vector2 } from "three";
import { useStore } from "@renderer/store";
import { openFiles } from "@renderer/store/files";
import type { SpectrogramData } from "@renderer/store/types";
import { ipcSend } from "./ipc";

const MANIFEST_FILENAME = "tree.json";
const CHECKPOINT_INTERVAL = 20;
const AUDIO_LRU_CAPACITY = 5;

export type HistoryNodeKind = "root" | "stroke" | "resize" | "reanalyze" | "checkpoint";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HistoryDimensions {
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numBands: number;
  numChannels: number;
  sampleRate: number;
  minFreq: number;
  bandsPerOctave: number;
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
  dirtyRect?: Rect;
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

const HISTORY_MANIFEST_VERSION = 2;

interface HistoryManifest {
  version: typeof HISTORY_MANIFEST_VERSION;
  rootId: string;
  currentId: string;
  nodes: Record<string, HistoryNode>;
}

// --- Pure codec ---

/**
 * Compute a dirty-rectangle delta patch as `after - before` for each pixel in
 * the bounding box of changed pixels. Unchanged pixels inside the box become
 * exact zeros, which zstd collapses into near-nothing — dramatically smaller
 * on disk than storing absolute after-values (which carry the full base value
 * even in untouched regions of the bbox).
 *
 * Reconstruct with applyDelta(base, rect, patch, tW) → element-wise add.
 */
export function computeDeltaRect(
  before: Float32Array,
  after: Float32Array,
  textureWidth: number,
  textureHeight: number,
): { rect: Rect; patch: Float32Array } | null {
  let minX = textureWidth;
  let minY = textureHeight;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < textureHeight; y++) {
    const rowBase = y * textureWidth * 4;
    for (let x = 0; x < textureWidth; x++) {
      const i = rowBase + x * 4;
      if (
        before[i] !== after[i] ||
        before[i + 1] !== after[i + 1] ||
        before[i + 2] !== after[i + 2] ||
        before[i + 3] !== after[i + 3]
      ) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const patch = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = (minY + y) * textureWidth * 4;
    const dstRow = y * w * 4;
    for (let x = 0; x < w; x++) {
      const srcI = srcRow + (minX + x) * 4;
      const dstI = dstRow + x * 4;
      patch[dstI] = after[srcI] - before[srcI];
      patch[dstI + 1] = after[srcI + 1] - before[srcI + 1];
      patch[dstI + 2] = after[srcI + 2] - before[srcI + 2];
      patch[dstI + 3] = after[srcI + 3] - before[srcI + 3];
    }
  }

  return { rect: { x: minX, y: minY, w, h }, patch };
}

export function applyDelta(base: Float32Array, rect: Rect, patch: Float32Array, textureWidth: number): Float32Array {
  const out = new Float32Array(base);
  for (let y = 0; y < rect.h; y++) {
    const dstRow = (rect.y + y) * textureWidth * 4;
    const srcRow = y * rect.w * 4;
    for (let x = 0; x < rect.w; x++) {
      const dstI = dstRow + (rect.x + x) * 4;
      const srcI = srcRow + x * 4;
      out[dstI] += patch[srcI];
      out[dstI + 1] += patch[srcI + 1];
      out[dstI + 2] += patch[srcI + 2];
      out[dstI + 3] += patch[srcI + 3];
    }
  }
  return out;
}

// --- Helpers ---

function shortId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function getUserDataPath(): Promise<string> {
  return (await window.ipcRenderer.invoke("get-user-data-path")) as string;
}

async function zstdCompress(data: Uint8Array): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    window.nodeZlib.zstdCompress(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err, out) => {
      if (err) reject(err);
      else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
    });
  });
}

async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    window.nodeZlib.zstdDecompress(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err, out) => {
      if (err) reject(err);
      else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
    });
  });
}

async function writeFloat32Compressed(filePath: string, arr: Float32Array): Promise<void> {
  const raw = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  const compressed = await zstdCompress(raw);
  await window.nodeFs.writeFile(filePath, Buffer.from(compressed));
}

async function readFloat32Compressed(filePath: string): Promise<Float32Array> {
  const buf = await window.nodeFs.readFile(filePath);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = await zstdDecompress(bytes);
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
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
}

export class HistoryManager {
  private readonly fileId: string;
  private readonly dir: Promise<string>;
  private manifest: HistoryManifest | null = null;
  private initPromise: Promise<void> | null = null;
  private currentPacked: Float32Array | null = null;
  private audioLru: string[] = [];
  private listeners = new Set<() => void>();
  private version = 0;

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
    return window.nodePath.join(userData, "history", this.fileId);
  }

  private async ensureDir(): Promise<string> {
    const dir = await this.dir;
    await window.nodeFs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async readManifest(): Promise<HistoryManifest | null> {
    try {
      const dir = await this.dir;
      const path = window.nodePath.join(dir, MANIFEST_FILENAME);
      const buf = await window.nodeFs.readFile(path, "utf8");
      const parsed = JSON.parse(buf as unknown as string) as { version?: number } & HistoryManifest;
      if (parsed.version !== HISTORY_MANIFEST_VERSION) {
        // Delta format changed incompatibly in v2 (absolute after-values →
        // diff values). Old trees would decode wrong, so wipe and start over.
        console.warn(
          `history: tree.json version ${parsed.version} is incompatible with ${HISTORY_MANIFEST_VERSION}, wiping`,
        );
        await window.nodeFs.rm(dir, { recursive: true, force: true });
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeManifest(): Promise<void> {
    if (!this.manifest) return;
    const dir = await this.ensureDir();
    const path = window.nodePath.join(dir, MANIFEST_FILENAME);
    await window.nodeFs.writeFile(path, JSON.stringify(this.manifest));
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
      if (loaded) this.manifest = loaded;
    })();
    await this.initPromise;
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
    this.emit();
  }

  // ---------- File paths ----------

  private packedPath(dir: string, nodeId: string): string {
    return window.nodePath.join(dir, `${nodeId}.packed.zst`);
  }
  private deltaPath(dir: string, nodeId: string): string {
    return window.nodePath.join(dir, `${nodeId}.delta.zst`);
  }
  private inverseMapPath(dir: string, nodeId: string): string {
    return window.nodePath.join(dir, `${nodeId}.inverse.zst`);
  }
  private metadataPath(dir: string, nodeId: string): string {
    return window.nodePath.join(dir, `${nodeId}.meta.zst`);
  }
  private audioPath(dir: string, nodeId: string): string {
    return window.nodePath.join(dir, `${nodeId}.wav`);
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
    await this.writeManifest();
    this.notifyStateChange();
    return id;
  }

  /**
   * Append a stroke as a child of the current node. Stored as a dirty-rect delta if
   * dimensions still match, otherwise as a raw packed snapshot.
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

    let storage: "delta" | "packed";
    let dirtyRect: Rect | undefined;

    if (sameDims && this.currentPacked && this.currentPacked.length === opts.data.length) {
      const diff = computeDeltaRect(
        this.currentPacked,
        opts.data,
        opts.dimensions.textureWidth,
        opts.dimensions.textureHeight,
      );
      if (!diff) {
        // No change — skip creating a node.
        return parentId;
      }

      // Insert a checkpoint every CHECKPOINT_INTERVAL strokes on this chain.
      const stepsSinceSnap = this.deltaStepsSinceLastSnap(parentId);
      if (stepsSinceSnap >= CHECKPOINT_INTERVAL) {
        storage = "packed";
      } else {
        storage = "delta";
        dirtyRect = diff.rect;
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
      dirtyRect,
    };

    const dir = await this.ensureDir();
    if (storage === "delta" && dirtyRect) {
      const diff = computeDeltaRect(
        this.currentPacked!,
        opts.data,
        opts.dimensions.textureWidth,
        opts.dimensions.textureHeight,
      )!;
      await writeFloat32Compressed(this.deltaPath(dir, id), diff.patch);
    } else {
      await writeFloat32Compressed(this.packedPath(dir, id), opts.data);
    }

    this.linkChild(parentId, id);
    this.manifest.nodes[id] = node;
    this.manifest.currentId = id;
    this.currentPacked = new Float32Array(opts.data);
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
    const dir = await this.ensureDir();
    await writeFloat32Compressed(this.packedPath(dir, nodeId), packed);
    await writeFloat32Compressed(this.inverseMapPath(dir, nodeId), s.inverseMap);
    await writeFloat32Compressed(this.metadataPath(dir, nodeId), s.metadata);
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
      if (n.storage === "delta" && n.dirtyRect) {
        const patch = await readFloat32Compressed(this.deltaPath(dir, n.id));
        packed = applyDelta(packed, n.dirtyRect, patch, n.dimensions.textureWidth);
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

    const { packedData, fullAnchor } = await this.reconstruct(targetId);

    // If the lineage walks back to a full snapshot (root/resize/reanalyze),
    // restore the file's spectrogramData from that anchor so textures
    // (inverseMap, metadata, dims) match.
    if (fullAnchor) {
      await this.restoreSpectrogramFromFull(fullAnchor, packedData);
    } else {
      file.rendererRef.current.setFBOData(packedData);
    }

    this.manifest.currentId = targetId;
    this.currentPacked = new Float32Array(packedData);
    await this.writeManifest();
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
      await window.audioAnalysis.exportAudio(channels, path, audioBuffer.sampleRate, "wav");
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
      window.nodeFs.rm(this.audioPath(dir, evict)).catch(() => {});
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
      for (const f of files) window.nodeFs.rm(f).catch(() => {});
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
        await window.audioAnalysis.copyAudioFile(cached, outputPath);
        return true;
      } catch {
        // Cached copy failed (file evicted or permission issue) — fall through
        // to re-synthesis without mutating the manifest.
      }
    }

    // Walk ancestors to the nearest full snapshot — it carries the
    // synthesisMetadata (bandOffsets/bandStepLog2s/bandLengths) needed by the
    // gaborator synthesizer. Stroke chains inherit those from their last
    // resize/reanalyze ancestor.
    let anchor: HistoryNode | null = target;
    while (anchor && anchor.storage !== "full") {
      anchor = anchor.parentId ? (this.manifest.nodes[anchor.parentId] ?? null) : null;
    }
    if (!anchor?.synthesisMetadata) return false;

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
    const result = await window.audioAnalysis.synthesize(
      packedData,
      synthMeta,
      dims.sampleRate,
      { bandsPerOctave: dims.bandsPerOctave, minFreq: dims.minFreq },
      true,
    );
    await window.audioAnalysis.exportAudio(result.channels, outputPath, dims.sampleRate, "wav");
    return true;
  }

  async getDiskUsageBytes(): Promise<number> {
    try {
      const dir = await this.dir;
      const entries = await window.nodeFs.readdir(dir);
      let total = 0;
      for (const entry of entries) {
        try {
          const s = await window.nodeFs.stat(window.nodePath.join(dir, entry));
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
   * Wipe the entire tree and directory. Next call to add* will re-seed from the root.
   */
  async purge(): Promise<void> {
    const dir = await this.dir;
    try {
      await window.nodeFs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    this.manifest = null;
    this.currentPacked = null;
    this.audioLru = [];
    this.notifyStateChange();
  }

  /**
   * Drop in-memory state. On-disk history is preserved so it can be rehydrated
   * on the next launch.
   */
  dispose(): void {
    this.manifest = null;
    this.currentPacked = null;
    this.audioLru = [];
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
    const root = window.nodePath.join(userData, "history");
    let entries: string[];
    try {
      entries = (await window.nodeFs.readdir(root)) as unknown as string[];
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (activeFileIds.has(entry)) return;
        const dir = window.nodePath.join(root, entry);
        try {
          await window.nodeFs.rm(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }),
    );
  } catch {
    // best-effort
  }
}
