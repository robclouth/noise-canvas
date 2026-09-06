import type { BandLayout } from "./band-layout";
import { blockGrid } from "./block-grid";
import { BlockStore, fileBlockBackend, type PackedStateStore } from "./block-store";
import { canvasHoldsWholeFile } from "./gpu-budget";
import { historyCacheBudgets } from "./history-cache-budgets";
import { host } from "./host";
import { WholeStateStore } from "./whole-state-store";

/** What a file's store needs beyond its band layout. */
export type BlockStoreShape = {
  numFrames: number;
  sampleRate: number;
  texelCount: number;
};

const stores = new Map<string, Promise<PackedStateStore>>();

async function blocksRootDir(): Promise<string> {
  return host.path.join(await host.dialogs.getUserDataPath(), "blocks");
}

/** Where a file's blocks live on disk. */
export async function blockStoreDirectory(fileId: string): Promise<string> {
  return host.path.join(await blocksRootDir(), fileId);
}

/** The open store for a file, or null when none has been opened. */
export function getBlockStore(fileId: string): Promise<PackedStateStore> | null {
  return stores.get(fileId) ?? null;
}

/**
 * Opens the store holding a file's packed state, creating it over
 * `<userData>/blocks/<fileId>` when the file has none open. The seed lives in
 * that directory as blocks, untouched after it is written. A file the canvas
 * pages through a window keeps its tier on disk too: patched blocks flush
 * into the `current` overlay, so the root state survives any torn write. A
 * file the canvas holds whole keeps its tier in RAM and writes only the seed.
 * The resident budget scales with system memory: the blocks a stroke reads
 * stay decoded for the next one, while a file longer than the budget still
 * cannot hold itself decoded.
 */
export function openBlockStore(fileId: string, layout: BandLayout, shape: BlockStoreShape): Promise<PackedStateStore> {
  let store = stores.get(fileId);
  if (!store) {
    store = (async () => {
      const grid = blockGrid(layout, shape.numFrames, shape.sampleRate);
      const dir = await blockStoreDirectory(fileId);
      const maxResidentBytes = historyCacheBudgets(host.os.totalmem()).blockResident;
      if (canvasHoldsWholeFile(grid)) {
        return new WholeStateStore(grid, fileBlockBackend(dir), { texelCount: shape.texelCount, maxResidentBytes });
      }
      return new BlockStore(grid, fileBlockBackend(dir), {
        overlay: fileBlockBackend(host.path.join(dir, "current")),
        texelCount: shape.texelCount,
        maxResidentBytes,
      });
    })();
    stores.set(fileId, store);
  }
  return store;
}

/** Deletes a file's blocks, on disk and in RAM. */
export async function destroyBlockStore(fileId: string): Promise<void> {
  const store = stores.get(fileId);
  stores.delete(fileId);
  if (store) await (await store).dispose();
}

/** Drops the open stores, keeping their disk for the next launch. */
export async function releaseBlockStores(): Promise<void> {
  const open = [...stores.values()];
  stores.clear();
  for (const store of open) await (await store).flush();
}

/** Removes block directories that belong to none of `keepIds`. */
export async function sweepOrphanBlocks(keepIds: Set<string>): Promise<void> {
  let root: string;
  let entries: string[];
  try {
    root = await blocksRootDir();
    entries = await host.fs.readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (keepIds.has(entry)) return;
      try {
        await host.fs.rm(host.path.join(root, entry), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }),
  );
}

/** Decoded block bytes resident across every open store. */
export async function blockStoreResidentBytes(): Promise<number> {
  let bytes = 0;
  for (const store of stores.values()) bytes += (await store).residentBytes;
  return bytes;
}
