import { produce } from "immer";
import type { State, ZustandGet, ZustandSet } from "./types";

/** Which separator produced a group's members, or `user` for a hand-made one. */
export type FileGroupMethod = "hpss" | "ai" | "nmf" | "user";

/**
 * A set of files bracketed together on the canvas. The members are ordinary
 * files — every brush and effect works on them unchanged — but they share a
 * colour, can move their views together, and can be merged into one file.
 */
export type FileGroup = {
  id: string;
  method: FileGroupMethod;
  /** Shown on the group header, e.g. "loop — 6 parts". */
  label: string;
  /** The file a split came from, null for a hand-made group. May be closed since. */
  originId: string | null;
  /** In split order: low-to-high spectral centroid for NMF, model order for AI. */
  memberIds: string[];
  /** Hue shared by every member so the group reads as one unit. */
  hue: number;
  /** Whether zoom and scroll follow each other across members. */
  syncView: boolean;
};

export const FILE_GROUPS_PERSISTED_KEYS = ["fileGroups", "fileGroupOfFile"] as const;

export interface FileGroupsState {
  fileGroups: Record<string, FileGroup>;
  /** Reverse index: fileId → groupId, for the per-file lookups the UI does. */
  fileGroupOfFile: Record<string, string>;
  createFileGroup: (group: Omit<FileGroup, "id" | "syncView"> & { syncView?: boolean }) => string;
  setFileGroupSyncView: (groupId: string, syncView: boolean) => void;
  /**
   * Drop a file from whatever group it belongs to. A group holds any number of
   * files, down to one, so only emptying it discards it.
   */
  removeFileFromGroup: (fileId: string) => void;
  /** Discard a group, leaving every member open as a file on its own. */
  ungroupFiles: (groupId: string) => void;
  /**
   * Move a file into `groupId`, or out of every group when it is null, and read
   * every group's members back in `order` — the canvas order the caller has just
   * settled, which is what the member colours and the merge follow. A group is
   * discarded once the move empties it.
   */
  setFileGroup: (fileId: string, groupId: string | null, order: string[]) => void;
}

let fileGroupCounter = 0;

function nextFileGroupId(): string {
  fileGroupCounter++;
  return `group_${Date.now()}_${fileGroupCounter}`;
}

/**
 * Per-member colour: one hue for the group, stepped in lightness so members are
 * still told apart at a glance. A lone member sits in the middle of the range.
 */
export function groupMemberColor(hue: number, index: number, count: number): string {
  const lightness = count > 1 ? 42 + (30 * Math.max(0, index)) / (count - 1) : 57;
  return `hsl(${hue}, 62%, ${lightness}%)`;
}

/** Colour for group-level chrome (the bracket rail, the group header border). */
export function fileGroupColor(hue: number): string {
  return `hsl(${hue}, 62%, 57%)`;
}

/**
 * The group a file belongs to, or undefined. Returns the stored group object so
 * it stays reference-stable across unrelated store updates.
 */
export function selectFileGroup(
  state: Pick<State, "fileGroups" | "fileGroupOfFile">,
  fileId: string,
): FileGroup | undefined {
  const groupId = state.fileGroupOfFile[fileId];
  return groupId ? state.fileGroups[groupId] : undefined;
}

/**
 * Every file that sounds together with `fileId`: the members of its group, or
 * just the file itself when it belongs to none. This is the set a mute, a solo
 * and a volume are resolved against.
 */
export function selectMixFileIds(state: Pick<State, "fileGroups" | "fileGroupOfFile">, fileId: string): string[] {
  return selectFileGroup(state, fileId)?.memberIds ?? [fileId];
}

/** How a group's method reads in the UI. */
export function groupMethodLabel(method: FileGroupMethod): string {
  switch (method) {
    case "hpss":
      return "HPSS";
    case "ai":
      return "AI stems";
    case "nmf":
      return "NMF";
    case "user":
      return "Group";
  }
}

export type FileSegment = {
  /** Null for files that belong to no group. */
  groupId: string | null;
  fileIds: string[];
};

/**
 * Split the open-file order into runs of adjacent files that share a group, so
 * the canvas can wrap each run in one bracket. Members are inserted contiguously
 * at split time; if anything ever separates them, each run brackets on its own
 * rather than drawing a rail across unrelated files.
 */
export function getFileSegments(openFileIds: string[], fileGroupOfFile: Record<string, string>): FileSegment[] {
  const segments: FileSegment[] = [];
  for (const fileId of openFileIds) {
    const groupId = fileGroupOfFile[fileId] ?? null;
    const last = segments[segments.length - 1];
    if (last && last.groupId === groupId && groupId !== null) {
      last.fileIds.push(fileId);
    } else if (last && last.groupId === null && groupId === null) {
      last.fileIds.push(fileId);
    } else {
      segments.push({ groupId, fileIds: [fileId] });
    }
  }
  return segments;
}

export const createFileGroupsSlice = (set: ZustandSet, get: ZustandGet): FileGroupsState => ({
  fileGroups: {},
  fileGroupOfFile: {},

  createFileGroup: (group) => {
    const id = nextFileGroupId();
    set(
      produce((state: State) => {
        state.fileGroups[id] = { ...group, id, syncView: group.syncView ?? true };
        for (const memberId of group.memberIds) {
          state.fileGroupOfFile[memberId] = id;
        }
      }),
    );
    return id;
  },

  setFileGroupSyncView: (groupId, syncView) => {
    set(
      produce((state: State) => {
        const group = state.fileGroups[groupId];
        if (group) group.syncView = syncView;
      }),
    );
  },

  setFileGroup: (fileId, groupId, order) => {
    set(
      produce((state: State) => {
        const from = state.fileGroupOfFile[fileId];
        if (from && from !== groupId) {
          delete state.fileGroupOfFile[fileId];
          const group = state.fileGroups[from];
          if (group) {
            group.memberIds = group.memberIds.filter((id) => id !== fileId);
            if (group.memberIds.length === 0) delete state.fileGroups[from];
          }
        }

        const group = groupId ? state.fileGroups[groupId] : undefined;
        if (group) {
          state.fileGroupOfFile[fileId] = group.id;
          if (!group.memberIds.includes(fileId)) group.memberIds.push(fileId);
        } else {
          delete state.fileGroupOfFile[fileId];
        }

        const position = new Map(order.map((id, index) => [id, index]));
        for (const each of Object.values(state.fileGroups)) {
          each.memberIds.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
        }
      }),
    );
  },

  ungroupFiles: (groupId) => {
    set(
      produce((state: State) => {
        const group = state.fileGroups[groupId];
        if (!group) return;
        for (const memberId of group.memberIds) delete state.fileGroupOfFile[memberId];
        delete state.fileGroups[groupId];
      }),
    );
  },

  removeFileFromGroup: (fileId) => {
    const groupId = get().fileGroupOfFile[fileId];
    if (!groupId) return;
    set(
      produce((state: State) => {
        delete state.fileGroupOfFile[fileId];
        const group = state.fileGroups[groupId];
        if (!group) return;
        group.memberIds = group.memberIds.filter((id) => id !== fileId);
        if (group.memberIds.length === 0) delete state.fileGroups[groupId];
      }),
    );
  },
});
