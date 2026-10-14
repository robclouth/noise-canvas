import { useStore } from "@renderer/store";
import { installLayeredHistories, openFiles } from "@renderer/store/files";
import { selectLayerOwner, selectLayerStack } from "@renderer/store/layers";
import { getHistoryManager } from "./history-manager";
import { host } from "./host";
import { LayeredHistory, type LayerHost } from "./layered-history";

const TREE_FILENAME = "file-tree.json";
const RENDERER_WAIT_MS = 20000;

async function treePath(ownerId: string): Promise<{ dir: string; path: string }> {
  const userData = await host.dialogs.getUserDataPath();
  const dir = host.path.join(userData, "history", ownerId);
  return { dir, path: host.path.join(dir, TREE_FILENAME) };
}

/** Resolves once the layer has a canvas that history can navigate, or after a wait it gives up on. */
async function layerReady(layerId: string): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < RENDERER_WAIT_MS) {
    const state = useStore.getState();
    if (!openFiles[layerId]) return;
    if (!state.filesLoading[layerId] && openFiles[layerId]?.rendererRef?.current) return;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

const appHost: LayerHost = {
  historyOf: (layerId) => getHistoryManager(layerId),
  shownLayers: (ownerId) => selectLayerStack(useStore.getState(), ownerId)?.layerIds ?? [ownerId],
  hideLayers: (ownerId, layerIds) => useStore.getState().hideFileLayers(ownerId, layerIds),
  showLayers: (ownerId, layerIds) => useStore.getState().showFileLayers(ownerId, layerIds),
  orderLayers: (ownerId, order) => useStore.getState().orderFileLayers(ownerId, order),
  nameLayers: (_ownerId, layers) => useStore.getState().setLayerNames(layers),
  focusLayer: async (layerId) => {
    if (useStore.getState().activeFileId !== layerId) await useStore.getState().setActiveFileId(layerId);
    await layerReady(layerId);
  },
  readTree: async (ownerId) => {
    try {
      const { path } = await treePath(ownerId);
      return (await host.fs.readFile(path, "utf8")) as unknown as string;
    } catch {
      return null;
    }
  },
  writeTree: async (ownerId, json) => {
    const { dir, path } = await treePath(ownerId);
    await host.fs.mkdir(dir, { recursive: true });
    await host.fs.writeFile(path, json);
  },
};

const histories = new Map<string, LayeredHistory>();

/** The layered history of `ownerId`'s file, loading it on first use. */
export function getLayeredHistory(ownerId: string): LayeredHistory {
  let history = histories.get(ownerId);
  if (!history) {
    history = new LayeredHistory(ownerId, appHost);
    histories.set(ownerId, history);
    useStore.getState().markLayeredFile(ownerId);
    void history.load().catch((error: unknown) => console.error("Loading a layered history failed:", error));
  }
  return history;
}

/** The layered history `fileId` belongs to, or null when its file keeps a history of its own. */
export function layeredHistoryOf(fileId: string): LayeredHistory | null {
  const ownerId = selectLayerOwner(useStore.getState(), fileId);
  return ownerId ? getLayeredHistory(ownerId) : null;
}

/** Stops `ownerId`'s layered history, writing what is pending. Its tree stays on disk. */
export async function releaseLayeredHistory(ownerId: string): Promise<void> {
  const history = histories.get(ownerId);
  histories.delete(ownerId);
  await history?.dispose();
}

/** Writes every layered history's pending changes, for quitting. */
export async function releaseLayeredHistories(): Promise<void> {
  const open = [...histories.values()];
  histories.clear();
  await Promise.all(open.map((history) => history.dispose()));
}

installLayeredHistories({ get: getLayeredHistory, release: releaseLayeredHistory });
