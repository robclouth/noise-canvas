import type { CurrentChangeCause } from "./history-manager";
import {
  addStep,
  currentLayers,
  currentNode,
  focusLayerOfMove,
  mirrorOwnerTree,
  moveTo,
  parseFileTree,
  redoTarget,
  undoTarget,
  withLayerAt,
  type FileTreeData,
  type LayerRef,
  type MirroredNode,
} from "./file-tree";

const TREE_WRITE_DEBOUNCE_MS = 400;

/** The part of one layer's own history the file tree drives and listens to. */
export interface LayerHistory {
  initialize(): Promise<boolean>;
  getManifest(): { rootId: string; currentId: string; nodes: Record<string, MirroredNode> } | null;
  onCurrentChanged(listener: (nodeId: string, cause: CurrentChangeCause) => void): () => void;
  navigateTo(nodeId: string): Promise<void>;
}

/** What the file tree needs from the app around it. */
export interface LayerHost {
  historyOf(layerId: string): LayerHistory;
  /** The layers the file shows now, in tab order. */
  shownLayers(ownerId: string): string[];
  /** Takes layers out of the file, keeping their histories on disk. */
  hideLayers(ownerId: string, layerIds: string[]): Promise<void>;
  /** Brings hidden layers back from disk. False when one could not come back. */
  showLayers(ownerId: string, layerIds: string[]): Promise<boolean>;
  /** Puts the file's layers in this tab order. */
  orderLayers(ownerId: string, order: string[]): void;
  /** Shows these names on the file's layer tabs. */
  nameLayers(ownerId: string, layers: LayerRef[]): void;
  /** Makes `layerId` the layer on screen, and waits until its canvas can navigate. */
  focusLayer(layerId: string): Promise<void>;
  readTree(ownerId: string): Promise<string | null>;
  writeTree(ownerId: string, json: string): Promise<void>;
}

/**
 * The history of one file with layers. Records each layer's steps in the order
 * they happen and walks them back as one, showing and hiding layers as the
 * steps that added or removed them are undone and redone.
 */
export class LayeredHistory {
  private tree: FileTreeData | null = null;
  private loading: Promise<void> | null = null;
  private watched = new Map<string, () => void>();
  /** Layers this history is moving, whose own navigation it must not record. */
  private moving = new Set<string>();
  /** Layers whose next steps a caller records itself, as part of a larger one. */
  private quiet = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private disposed = false;

  constructor(
    readonly ownerId: string,
    private readonly host: LayerHost,
  ) {}

  /** Loads the stored tree, or mirrors the owner's own history when there is none. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const stored = await this.host.readTree(this.ownerId);
      const parsed = stored ? parseFileTree(stored) : null;
      if (parsed && parsed.ownerId === this.ownerId) {
        this.tree = parsed;
      } else {
        const owner = this.host.historyOf(this.ownerId);
        await owner.initialize();
        const manifest = owner.getManifest();
        if (!manifest) throw new Error("The file has no history to build its layers on.");
        this.tree = mirrorOwnerTree(this.ownerId, manifest.nodes, manifest.rootId, manifest.currentId);
        await this.host.writeTree(this.ownerId, JSON.stringify(this.tree));
      }
      if (this.disposed) return;
      this.watch();
      this.reconcile();
      this.host.nameLayers(this.ownerId, this.layers());
      this.emit();
    })();
    return this.loading;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  canUndo(): boolean {
    return this.tree !== null && undoTarget(this.tree) !== null;
  }

  canRedo(): boolean {
    return this.tree !== null && redoTarget(this.tree) !== null;
  }

  /** The layers the file has at its current step, in tab order. */
  layers(): LayerRef[] {
    return this.tree ? currentLayers(this.tree) : [{ layerId: this.ownerId, nodeId: null }];
  }

  /** The tree as stored, or null before it loads. */
  data(): FileTreeData | null {
    return this.tree;
  }

  /**
   * Records a step that changes the set of layers: `layers` is the file's
   * configuration once the change is made, which the caller makes afterwards.
   */
  async addLayersStep(label: string, layers: LayerRef[]): Promise<void> {
    await this.load();
    await this.enqueue(async () => {
      if (!this.tree) return;
      addStep(this.tree, { kind: "layers", label }, layers);
      this.watch();
      this.changed();
    });
  }

  /**
   * Runs `task` without recording the steps it makes on `layerIds`, so the
   * caller can record them, with what else it changes, as one step.
   */
  async quietly<T>(layerIds: string[], task: () => Promise<T>): Promise<T> {
    for (const layerId of layerIds) this.quiet.add(layerId);
    try {
      return await task();
    } finally {
      for (const layerId of layerIds) this.quiet.delete(layerId);
    }
  }

  undo(): Promise<void> {
    return this.enqueue(async () => {
      const target = this.tree && undoTarget(this.tree);
      if (target) await this.goTo(target);
    });
  }

  redo(): Promise<void> {
    return this.enqueue(async () => {
      const target = this.tree && redoTarget(this.tree);
      if (target) await this.goTo(target);
    });
  }

  navigateTo(nodeId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.tree?.nodes[nodeId]) await this.goTo(nodeId);
    });
  }

  /** Stops listening and writes what is pending. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const unwatch of this.watched.values()) unwatch();
    this.watched.clear();
    this.listeners.clear();
    await this.queue;
    await this.flush();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch((error: unknown) => console.error("Layered history step failed:", error));
    return run;
  }

  private async goTo(targetId: string): Promise<void> {
    const tree = this.tree;
    if (!tree) return;
    const fromId = tree.currentId;
    const target = tree.nodes[targetId];
    const wanted = target.layers.map((ref) => ref.layerId);
    const shown = this.host.shownLayers(this.ownerId);

    const hide = shown.filter((id) => !wanted.includes(id));
    const show = wanted.filter((id) => !shown.includes(id));
    if (hide.length) await this.host.hideLayers(this.ownerId, hide);
    if (show.length && !(await this.host.showLayers(this.ownerId, show))) return;
    this.host.orderLayers(this.ownerId, wanted);
    this.host.nameLayers(this.ownerId, target.layers);
    this.watch(wanted);

    for (const ref of target.layers) {
      const history = this.host.historyOf(ref.layerId);
      await history.initialize();
      const manifest = history.getManifest();
      if (!manifest) continue;
      const nodeId = ref.nodeId ?? manifest.rootId;
      if (manifest.currentId === nodeId || !manifest.nodes[nodeId]) continue;
      await this.host.focusLayer(ref.layerId);
      this.moving.add(ref.layerId);
      try {
        await history.navigateTo(nodeId);
      } finally {
        this.moving.delete(ref.layerId);
      }
    }

    const focus = focusLayerOfMove(tree, fromId, targetId);
    if (focus && wanted.includes(focus)) await this.host.focusLayer(focus);
    moveTo(tree, targetId);
    this.changed();
  }

  /** Listens to the layers of the current step, or of `layerIds` while moving to another. */
  private watch(layerIds = this.layers().map((ref) => ref.layerId)): void {
    for (const [layerId, unwatch] of this.watched) {
      if (layerIds.includes(layerId)) continue;
      unwatch();
      this.watched.delete(layerId);
    }
    for (const layerId of layerIds) {
      if (this.watched.has(layerId)) continue;
      const history = this.host.historyOf(layerId);
      this.watched.set(
        layerId,
        history.onCurrentChanged((nodeId, cause) => this.record(layerId, nodeId, cause)),
      );
    }
  }

  private record(layerId: string, nodeId: string, cause: CurrentChangeCause): void {
    const tree = this.tree;
    if (!tree || this.disposed) return;
    if (this.quiet.has(layerId)) return;
    if (cause === "navigated" && this.moving.has(layerId)) return;
    const layers = currentLayers(tree);
    if (!layers.some((ref) => ref.layerId === layerId)) return;
    if (layers.some((ref) => ref.layerId === layerId && ref.nodeId === nodeId)) return;
    addStep(tree, { kind: "edit", layerId }, withLayerAt(layers, layerId, nodeId));
    this.changed();
  }

  /** Records, as steps, any layer that moved while this history was not listening. */
  private reconcile(): void {
    const tree = this.tree;
    if (!tree) return;
    for (const ref of currentNode(tree).layers) {
      const manifest = this.host.historyOf(ref.layerId).getManifest();
      if (!manifest) continue;
      const expected = ref.nodeId ?? manifest.rootId;
      if (manifest.currentId !== expected && manifest.nodes[manifest.currentId]) {
        this.record(ref.layerId, manifest.currentId, "added");
      }
    }
  }

  private changed(): void {
    this.host.nameLayers(this.ownerId, this.layers());
    this.scheduleWrite();
    this.emit();
  }

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, TREE_WRITE_DEBOUNCE_MS);
  }

  /** Writes the tree now, cancelling a pending debounced write. */
  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.tree) await this.host.writeTree(this.ownerId, JSON.stringify(this.tree));
  }
}
