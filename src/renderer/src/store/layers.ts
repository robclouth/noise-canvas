import { produce } from "immer";
import type { State, ZustandGet, ZustandSet } from "./types";

/** Which separator produced a stack's layers, or `user` for a hand-made one. */
export type LayerStackMethod = "hpss" | "ai" | "nmf" | "user";

/**
 * How a stack shows its layers. Overlaid shows one layer at a time in one
 * canvas, picked by its tab; stacked gives each a box of its own.
 */
export type LayerStackLayout = "overlaid" | "stacked";

/** A split drops you straight into one canvas with a tab per part. */
export const DEFAULT_LAYER_STACK_LAYOUT: LayerStackLayout = "overlaid";

/**
 * A set of layers held together on the canvas. A layer is an ordinary file —
 * every brush and effect works on one unchanged — but the layers of a stack
 * share a colour, sound together, can move their views together, and can be
 * merged into one file.
 */
export type LayerStack = {
  id: string;
  method: LayerStackMethod;
  /** Shown on the stack header, e.g. "loop — 6 parts". */
  label: string;
  /** The file a split came from, null for a hand-made stack. May be closed since. */
  originId: string | null;
  /**
   * The file these layers belong to, when the stack is one file with layers:
   * its first layer, whose history orders every layer's steps. Absent on a
   * stack of separate files.
   */
  ownerId?: string;
  /** In split order: low-to-high spectral centroid for NMF, model order for AI. */
  layerIds: string[];
  /** Hue shared by every layer so the stack reads as one unit. */
  hue: number;
  /** Whether zoom and scroll follow each other across the layers. */
  syncView: boolean;
  /** Overlaid shows one layer at a time in one canvas; stacked gives each its own box. */
  layout: LayerStackLayout;
};

/**
 * Converts persisted file groups, supplies the layout of a saved stack, and
 * makes every stack a file with layers, owned by its first layer.
 */
export function migrateLayerStacks(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const { memberIds, ...stack } = entry as Record<string, unknown>;
    const layerIds = stack.layerIds ?? memberIds;
    if (!Array.isArray(layerIds)) continue;
    const kept = layerIds.filter((layerId): layerId is string => typeof layerId === "string");
    const ownerId = typeof stack.ownerId === "string" ? stack.ownerId : kept[0];
    result[id] = {
      ...stack,
      layerIds: kept,
      layout: stack.layout ?? DEFAULT_LAYER_STACK_LAYOUT,
      ...(ownerId ? { ownerId } : {}),
    };
  }
  return result;
}

/** A layer an undo took out of its file, kept on disk so a redo can bring it back. */
export type DetachedLayer = {
  ownerId: string;
  filePath: string;
  displayName: string;
};

export const LAYER_STACKS_PERSISTED_KEYS = ["layerStacks", "stackOfLayer", "detachedLayers", "layeredFiles"] as const;

export interface LayerStacksState {
  layerStacks: Record<string, LayerStack>;
  /** Reverse index: layer id → stack id, for the per-layer lookups the UI does. */
  stackOfLayer: Record<string, string>;
  /** Hidden layers by id. Their history and blocks stay on disk until their file closes. */
  detachedLayers: Record<string, DetachedLayer>;
  /** Files whose history is a layered history, which outlives their layers. */
  layeredFiles: Record<string, true>;
  /** What each layer's tab reads, from the step that made it. Absent: the file's own name. */
  layerNames: Record<string, string>;
  /** Sets the tab names of a file's layers, clearing those the step gave none. */
  setLayerNames: (layers: { layerId: string; name?: string }[]) => void;
  /** Records that `fileId` keeps a layered history. */
  markLayeredFile: (fileId: string) => void;
  createLayerStack: (
    stack: Omit<LayerStack, "id" | "syncView" | "layout"> & { syncView?: boolean; layout?: LayerStackLayout },
  ) => string;
  setLayerStackSyncView: (stackId: string, syncView: boolean) => void;
  /** Switches a stack between one overlaid canvas and a box per layer. */
  setLayerStackLayout: (stackId: string, layout: LayerStackLayout) => void;
  /**
   * Drop a layer from whatever stack it belongs to. A stack holds any number of
   * layers, down to one, so only emptying it discards it.
   */
  removeLayerFromStack: (fileId: string) => void;
  /** Discard a stack, leaving every layer open as a file on its own. */
  unstackLayers: (stackId: string) => void;
  /**
   * Move a layer into `stackId`, or out of every stack when it is null, and read
   * every stack's layers back in `order` — the canvas order the caller has just
   * settled, which is what the layer colours and the merge follow. A stack is
   * discarded once the move empties it.
   */
  setLayerStack: (fileId: string, stackId: string | null, order: string[]) => void;
}

let layerStackCounter = 0;

function nextLayerStackId(): string {
  layerStackCounter++;
  return `stack_${Date.now()}_${layerStackCounter}`;
}

/** The colour a stack and each of its layers wear in the chrome. */
export function stackColor(hue: number): string {
  return `hsl(${hue}, 62%, 57%)`;
}

/**
 * The stack a layer belongs to, or undefined. Returns the stored stack object so
 * it stays reference-stable across unrelated store updates.
 */
export function selectLayerStack(
  state: Pick<State, "layerStacks" | "stackOfLayer">,
  fileId: string,
): LayerStack | undefined {
  const stackId = state.stackOfLayer[fileId];
  return stackId ? state.layerStacks[stackId] : undefined;
}

/**
 * The file `fileId` is a layer of, when that file keeps a layered history:
 * the stack's owner, or the file itself once it has had layers.
 */
export function selectLayerOwner(
  state: Pick<State, "layerStacks" | "stackOfLayer" | "layeredFiles">,
  fileId: string,
): string | null {
  const owner = selectLayerStack(state, fileId)?.ownerId;
  if (owner) return owner;
  return state.layeredFiles[fileId] ? fileId : null;
}

/**
 * Every layer that sounds together with `fileId`: the layers of its stack, or
 * just the file itself when it belongs to none. This is the set a mute, a solo
 * and a volume are resolved against.
 */
export function selectStackLayerIds(state: Pick<State, "layerStacks" | "stackOfLayer">, fileId: string): string[] {
  return selectLayerStack(state, fileId)?.layerIds ?? [fileId];
}

export type LayerSegment = {
  /** Null for layers that belong to no stack. */
  stackId: string | null;
  fileIds: string[];
};

/**
 * Split the open-file order into runs of adjacent layers that share a stack, so
 * the canvas can wrap each run in one rail. Layers are inserted contiguously at
 * split time; if anything ever separates them, each run rails on its own rather
 * than drawing across unrelated files.
 */
export function getLayerSegments(openFileIds: string[], stackOfLayer: Record<string, string>): LayerSegment[] {
  const segments: LayerSegment[] = [];
  for (const fileId of openFileIds) {
    const stackId = stackOfLayer[fileId] ?? null;
    const last = segments[segments.length - 1];
    if (last && last.stackId === stackId && stackId !== null) {
      last.fileIds.push(fileId);
    } else if (last && last.stackId === null && stackId === null) {
      last.fileIds.push(fileId);
    } else {
      segments.push({ stackId, fileIds: [fileId] });
    }
  }
  return segments;
}

export const createLayerStacksSlice = (set: ZustandSet, get: ZustandGet): LayerStacksState => ({
  layerStacks: {},
  stackOfLayer: {},
  detachedLayers: {},
  layeredFiles: {},
  layerNames: {},

  markLayeredFile: (fileId) => {
    if (get().layeredFiles[fileId]) return;
    set(
      produce((state: State) => {
        state.layeredFiles[fileId] = true;
      }),
    );
  },

  setLayerNames: (layers) => {
    set(
      produce((state: State) => {
        for (const { layerId, name } of layers) {
          if (name) state.layerNames[layerId] = name;
          else delete state.layerNames[layerId];
        }
      }),
    );
  },

  createLayerStack: (stack) => {
    const id = nextLayerStackId();
    set(
      produce((state: State) => {
        state.layerStacks[id] = {
          ...stack,
          id,
          syncView: stack.syncView ?? true,
          layout: stack.layout ?? DEFAULT_LAYER_STACK_LAYOUT,
        };
        for (const layerId of stack.layerIds) {
          state.stackOfLayer[layerId] = id;
        }
      }),
    );
    return id;
  },

  setLayerStackSyncView: (stackId, syncView) => {
    set(
      produce((state: State) => {
        const stack = state.layerStacks[stackId];
        if (stack) stack.syncView = syncView;
      }),
    );
  },

  setLayerStackLayout: (stackId, layout) => {
    set(
      produce((state: State) => {
        const stack = state.layerStacks[stackId];
        if (stack) stack.layout = layout;
      }),
    );
  },

  setLayerStack: (fileId, stackId, order) => {
    set(
      produce((state: State) => {
        const from = state.stackOfLayer[fileId];
        if (from && from !== stackId) {
          delete state.stackOfLayer[fileId];
          const stack = state.layerStacks[from];
          if (stack) {
            if (stack.ownerId === fileId) delete stack.ownerId;
            stack.layerIds = stack.layerIds.filter((id) => id !== fileId);
            if (stack.layerIds.length === 0) delete state.layerStacks[from];
          }
        }

        const stack = stackId ? state.layerStacks[stackId] : undefined;
        if (stack) {
          state.stackOfLayer[fileId] = stack.id;
          if (!stack.layerIds.includes(fileId)) stack.layerIds.push(fileId);
        } else {
          delete state.stackOfLayer[fileId];
        }

        const position = new Map(order.map((id, index) => [id, index]));
        for (const each of Object.values(state.layerStacks)) {
          each.layerIds.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
        }
      }),
    );
  },

  unstackLayers: (stackId) => {
    set(
      produce((state: State) => {
        const stack = state.layerStacks[stackId];
        if (!stack) return;
        for (const layerId of stack.layerIds) delete state.stackOfLayer[layerId];
        delete state.layerStacks[stackId];
      }),
    );
  },

  removeLayerFromStack: (fileId) => {
    const stackId = get().stackOfLayer[fileId];
    if (!stackId) return;
    set(
      produce((state: State) => {
        delete state.stackOfLayer[fileId];
        const stack = state.layerStacks[stackId];
        if (!stack) return;
        if (stack.ownerId === fileId) delete stack.ownerId;
        stack.layerIds = stack.layerIds.filter((id) => id !== fileId);
        if (stack.layerIds.length === 0) delete state.layerStacks[stackId];
      }),
    );
  },
});
