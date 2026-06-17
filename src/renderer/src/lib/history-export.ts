import { notifications } from "@mantine/notifications";
import truncateMiddle from "@stdlib/string-truncate-middle";
import type { HistoryManager } from "./history-manager";
import { historyExportProgressMessage } from "./history-export-progress";
import { host } from "./host";

// Exported via HistoryManager.getManifest(); duplicated here to avoid widening
// the manager's public surface for a local helper.
interface HistoryNodeLite {
  id: string;
  parentId: string | null;
  childIds: string[];
  label: string;
  customLabel?: string;
}
interface HistoryManifestLite {
  rootId: string;
  nodes: Record<string, HistoryNodeLite>;
}

export function slugifyNodeLabel(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 30) || "node"
  );
}

/**
 * For every node in the manifest, compute the underscore-joined path of 1-based
 * child indices from the root. Root → "", first-child-of-root → "1",
 * second-child-of-that → "1_2", etc. Any digit > 1 marks a branch point.
 */
export function buildChildIndexPaths(manifest: HistoryManifestLite): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (nodeId: string, path: string): void => {
    out.set(nodeId, path);
    const n = manifest.nodes[nodeId];
    if (!n) return;
    n.childIds.forEach((childId, i) => {
      const next = path ? `${path}_${i + 1}` : `${i + 1}`;
      walk(childId, next);
    });
  };
  walk(manifest.rootId, "");
  return out;
}

/** Build the chain of node IDs from root down to (and including) `nodeId`. */
export function chainFromRootTo(manifest: HistoryManifestLite, nodeId: string): string[] {
  const chain: string[] = [];
  let cursor: string | null = nodeId;
  while (cursor) {
    chain.unshift(cursor);
    cursor = manifest.nodes[cursor]?.parentId ?? null;
  }
  return chain;
}

export interface RunHistoryExportOpts {
  historyManager: HistoryManager;
  manifest: HistoryManifestLite;
  chains: string[][];
  outputRoot: string;
  pathOf: Map<string, string>;
  /** Subfolder name per chain index, or null to write directly into outputRoot. */
  folderFor: (chainIndex: number) => string | null;
  writeTreeJson: boolean;
  successNoun: string;
  successCount: number;
  /**
   * If true, filenames are `<slug>_<path-suffix>.wav` without the per-chain
   * ordinal prefix. Use for exports where every chain is a single node
   * (e.g. favorites), where a global `01-` prefix on every file is meaningless.
   */
  omitOrdinal?: boolean;
}

/**
 * Shared writer for history exports. Drives the progress toast, dedups
 * per-node synthesis via a shared canonical map, and writes each node as
 * `<ordinal>-<slug>_<path-suffix>.wav`.
 */
export async function runHistoryExport(opts: RunHistoryExportOpts): Promise<void> {
  const {
    historyManager,
    manifest,
    chains,
    outputRoot,
    pathOf,
    folderFor,
    writeTreeJson,
    successNoun,
    successCount,
    omitOrdinal,
  } = opts;

  const totalWrites = chains.reduce((s, c) => s + c.length, 0);
  const canonicalForNode = new Map<string, string>();

  const notificationId = `history-export-${Date.now()}`;
  let cancelled = false;
  const onCancel = () => {
    cancelled = true;
  };
  const errors: string[] = [];
  let exported = 0;

  notifications.show({
    id: notificationId,
    title: "Exporting history",
    message: historyExportProgressMessage(0, totalWrites, onCancel),
    loading: true,
    autoClose: false,
    withCloseButton: false,
  });

  outer: for (let p = 0; p < chains.length; p++) {
    const chain = chains[p];
    const folderName = folderFor(p);
    const dir = folderName ? host.path.join(outputRoot, folderName) : outputRoot;
    await host.fs.mkdir(dir, { recursive: true });
    const nodePad = Math.max(2, String(chain.length).length);

    for (let i = 0; i < chain.length; i++) {
      if (cancelled) break outer;
      const nodeId = chain[i];
      const node = manifest.nodes[nodeId];
      if (!node) continue;
      const slug = slugifyNodeLabel(node.customLabel ?? node.label);
      const suffix = pathOf.get(nodeId) ?? "";
      let fileName: string;
      if (omitOrdinal) {
        fileName = suffix ? `${slug}_${suffix}.wav` : `${slug}.wav`;
      } else {
        const ordinal = String(i + 1).padStart(nodePad, "0");
        fileName = suffix ? `${ordinal}-${slug}_${suffix}.wav` : `${ordinal}-${slug}.wav`;
      }
      const wavPath = host.path.join(dir, fileName);

      try {
        const cached = canonicalForNode.get(nodeId);
        if (cached) {
          await host.analysis.copyAudioFile(cached, wavPath);
          exported++;
        } else {
          const ok = await historyManager.exportNodeAudio(nodeId, wavPath);
          if (ok) {
            canonicalForNode.set(nodeId, wavPath);
            exported++;
          }
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      notifications.update({
        id: notificationId,
        title: "Exporting history",
        message: historyExportProgressMessage(exported + errors.length, totalWrites, onCancel),
        loading: true,
        autoClose: false,
        withCloseButton: false,
      });
    }
  }

  if (!cancelled && writeTreeJson) {
    try {
      await host.fs.writeFile(host.path.join(outputRoot, "tree.json"), JSON.stringify(manifest, null, 2));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (cancelled) {
    notifications.update({
      id: notificationId,
      title: "Export cancelled",
      message: `Exported ${exported} of ${totalWrites} before cancel.`,
      loading: false,
      autoClose: 4000,
      withCloseButton: true,
      color: "yellow",
    });
  } else if (errors.length > 0) {
    notifications.update({
      id: notificationId,
      title: "Export partially failed",
      message: `Exported ${exported} of ${totalWrites}. First error: ${errors[0]}`,
      loading: false,
      autoClose: 6000,
      withCloseButton: true,
      color: "red",
    });
  } else {
    notifications.update({
      id: notificationId,
      title: "History exported",
      message: `Exported ${successCount} ${successNoun} to ${truncateMiddle(outputRoot, 50)}`,
      loading: false,
      autoClose: 4000,
      withCloseButton: true,
    });
  }
}
