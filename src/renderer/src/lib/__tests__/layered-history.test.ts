import { describe, expect, it, vi } from "vitest";

vi.mock("../history-manager", () => ({}));

import type { CurrentChangeCause } from "../history-manager";
import type { MirroredNode } from "../file-tree";
import { LayeredHistory, type LayerHistory, type LayerHost } from "../layered-history";

/** A layer's own history: a tree of node ids with a current node. */
class FakeHistory implements LayerHistory {
  nodes: Record<string, MirroredNode> = {};
  currentId: string;
  private listeners = new Set<(nodeId: string, cause: CurrentChangeCause) => void>();

  constructor(readonly rootId: string) {
    this.nodes[rootId] = { id: rootId, parentId: null, childIds: [], lastChildId: null, timestamp: 0 };
    this.currentId = rootId;
  }

  async initialize(): Promise<boolean> {
    return true;
  }

  getManifest() {
    return { rootId: this.rootId, currentId: this.currentId, nodes: this.nodes };
  }

  onCurrentChanged(listener: (nodeId: string, cause: CurrentChangeCause) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A stroke: a new node after the current one. */
  paint(id: string): void {
    this.nodes[id] = { id, parentId: this.currentId, childIds: [], lastChildId: null, timestamp: 0 };
    this.nodes[this.currentId].childIds.push(id);
    this.currentId = id;
    for (const listener of this.listeners) listener(id, "added");
  }

  async navigateTo(nodeId: string): Promise<void> {
    this.currentId = nodeId;
    for (const listener of this.listeners) listener(nodeId, "navigated");
  }
}

/** The app around a file with layers: which layers it shows, and which one is on screen. */
class FakeHost implements LayerHost {
  histories = new Map<string, FakeHistory>();
  shown: string[];
  focused: string[] = [];
  stored: string | null = null;

  constructor(readonly ownerId: string) {
    this.shown = [ownerId];
  }

  history(layerId: string): FakeHistory {
    let history = this.histories.get(layerId);
    if (!history) {
      history = new FakeHistory(`${layerId}-root`);
      this.histories.set(layerId, history);
    }
    return history;
  }

  historyOf(layerId: string): LayerHistory {
    return this.history(layerId);
  }

  shownLayers(): string[] {
    return this.shown;
  }

  async hideLayers(_ownerId: string, layerIds: string[]): Promise<void> {
    this.shown = this.shown.filter((id) => !layerIds.includes(id));
  }

  async showLayers(_ownerId: string, layerIds: string[]): Promise<boolean> {
    this.shown = [...this.shown, ...layerIds];
    return true;
  }

  orderLayers(_ownerId: string, order: string[]): void {
    this.shown = [...order];
  }

  names: Record<string, string | undefined> = {};

  nameLayers(_ownerId: string, layers: { layerId: string; name?: string }[]): void {
    this.names = Object.fromEntries(layers.map((ref) => [ref.layerId, ref.name]));
  }

  async focusLayer(layerId: string): Promise<void> {
    this.focused.push(layerId);
  }

  async readTree(): Promise<string | null> {
    return this.stored;
  }

  async writeTree(_ownerId: string, json: string): Promise<void> {
    this.stored = json;
  }
}

/** A file "song" that already has one edit of its own, then gains a "drums" layer. */
async function fileWithDrums(): Promise<{ host: FakeHost; history: LayeredHistory }> {
  const host = new FakeHost("song");
  host.history("song").paint("s1");
  const history = new LayeredHistory("song", host);
  await history.load();
  await history.addLayersStep("Add layer", [...history.layers(), { layerId: "drums", nodeId: null }]);
  await host.showLayers("song", ["drums"]);
  return { host, history };
}

describe("a file's layered history", () => {
  it("undoes steps across layers in the order they happened, showing each layer it changes", async () => {
    const { host, history } = await fileWithDrums();
    host.history("drums").paint("d1");
    host.history("song").paint("s2");

    await history.undo();
    expect(host.history("song").currentId).toBe("s1");
    expect(host.focused.at(-1)).toBe("song");

    await history.undo();
    expect(host.history("drums").currentId).toBe("drums-root");
    expect(host.focused.at(-1)).toBe("drums");

    await history.undo();
    expect(host.shown).toEqual(["song"]);

    await history.undo();
    expect(host.history("song").currentId).toBe("song-root");
    expect(history.canUndo()).toBe(false);
  });

  it("brings a layer back with its edits when the step that removed it is redone", async () => {
    const { host, history } = await fileWithDrums();
    host.history("drums").paint("d1");
    await history.undo();
    await history.undo();
    expect(host.shown).toEqual(["song"]);

    await history.redo();
    expect(host.shown).toEqual(["song", "drums"]);
    await history.redo();
    expect(host.history("drums").currentId).toBe("d1");
    expect(history.canRedo()).toBe(false);
  });

  it("does not record its own moves as new steps", async () => {
    const { host, history } = await fileWithDrums();
    host.history("drums").paint("d1");
    const steps = Object.keys(history.data()!.nodes).length;
    await history.undo();
    await history.redo();
    expect(Object.keys(history.data()!.nodes).length).toBe(steps);
  });

  it("records a layer moved in its own history as a step, so undo takes the move back", async () => {
    const { host, history } = await fileWithDrums();
    host.history("song").paint("s2");
    await host.history("song").navigateTo("song-root");

    await history.undo();
    expect(host.history("song").currentId).toBe("s2");
  });

  it("keeps its place across a restart", async () => {
    const { host, history } = await fileWithDrums();
    host.history("drums").paint("d1");
    await history.undo();
    await history.dispose();

    const reopened = new LayeredHistory("song", host);
    await reopened.load();
    expect(reopened.layers()).toEqual([
      { layerId: "song", nodeId: "s1" },
      { layerId: "drums", nodeId: null },
    ]);
    await reopened.redo();
    expect(host.history("drums").currentId).toBe("d1");
  });

  it("records edits made while it was not loaded", async () => {
    const { host, history } = await fileWithDrums();
    await history.dispose();
    host.history("drums").paint("d1");

    const reopened = new LayeredHistory("song", host);
    await reopened.load();
    await reopened.undo();
    expect(host.history("drums").currentId).toBe("drums-root");
  });

  it("records a change made quietly, with the layers it adds, as one step that undo takes back whole", async () => {
    const host = new FakeHost("song");
    const history = new LayeredHistory("song", host);
    await history.load();
    await history.quietly(["song"], async () => host.history("song").paint("harmonic"));
    expect(history.canUndo()).toBe(false);

    await history.addLayersStep("Split (HPSS)", [
      { layerId: "song", nodeId: "harmonic", name: "harmonic" },
      { layerId: "perc", nodeId: null, name: "percussive" },
    ]);
    await host.showLayers("song", ["perc"]);
    expect(host.names).toEqual({ song: "harmonic", perc: "percussive" });

    await history.undo();
    expect(host.history("song").currentId).toBe("song-root");
    expect(host.shown).toEqual(["song"]);
    expect(host.names).toEqual({ song: undefined });
    expect(history.canUndo()).toBe(false);
  });

  it("takes in layers a file showed before its history, as one step undo can take back", async () => {
    const host = new FakeHost("song");
    host.shown = ["song", "perc"];
    host.history("perc").paint("p1");
    const history = new LayeredHistory("song", host);
    await history.load();
    expect(history.layers()).toEqual([
      { layerId: "song", nodeId: "song-root" },
      { layerId: "perc", nodeId: "p1" },
    ]);

    await history.undo();
    expect(host.shown).toEqual(["song"]);
    await history.redo();
    expect(host.shown).toEqual(["song", "perc"]);
    expect(host.history("perc").currentId).toBe("p1");
  });
});
