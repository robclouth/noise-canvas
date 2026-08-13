import { produce } from "immer";
import type { State, ZustandGet, ZustandSet } from "./types";

/** Which separator produced a group's members. */
export type StemGroupMethod = "hpss" | "ai" | "nmf";

/**
 * A set of files produced by one split of a single source file. The members are
 * ordinary files — every brush and effect works on them unchanged — but they are
 * tracked together because their coefficients still sum back to what they were
 * split from, which is what makes merging them meaningful.
 */
export type StemGroup = {
  id: string;
  method: StemGroupMethod;
  /** Shown on the group header, e.g. "loop — 6 parts". */
  label: string;
  /** The file the split came from. May have been closed since. */
  originId: string;
  /** In split order: low-to-high spectral centroid for NMF, model order for AI. */
  memberIds: string[];
  /** Hue shared by every member so the group reads as one unit. */
  hue: number;
  /** Whether zoom and scroll follow each other across members. */
  syncView: boolean;
};

export const STEM_GROUPS_PERSISTED_KEYS = ["stemGroups", "stemGroupOfFile"] as const;

export interface StemGroupsState {
  stemGroups: Record<string, StemGroup>;
  /** Reverse index: fileId → groupId, for the per-file lookups the UI does. */
  stemGroupOfFile: Record<string, string>;
  createStemGroup: (group: Omit<StemGroup, "id" | "syncView"> & { syncView?: boolean }) => string;
  setStemGroupSyncView: (groupId: string, syncView: boolean) => void;
  /**
   * Drop a file from whatever group it belongs to. A group that falls below two
   * members stops being a group and is discarded — the remaining file keeps its
   * contents, it just loses the bracket.
   */
  removeFileFromStemGroup: (fileId: string) => void;
}

let stemGroupCounter = 0;

function nextStemGroupId(): string {
  stemGroupCounter++;
  return `stemgroup_${Date.now()}_${stemGroupCounter}`;
}

/**
 * Per-member colour: one hue for the group, stepped in lightness so members are
 * still told apart at a glance. A lone member sits in the middle of the range.
 */
export function stemMemberColor(hue: number, index: number, count: number): string {
  const lightness = count > 1 ? 42 + (30 * Math.max(0, index)) / (count - 1) : 57;
  return `hsl(${hue}, 62%, ${lightness}%)`;
}

/** Colour for group-level chrome (the bracket rail, the group header border). */
export function stemGroupColor(hue: number): string {
  return `hsl(${hue}, 62%, 57%)`;
}

/**
 * The group a file belongs to, or undefined. Returns the stored group object so
 * it stays reference-stable across unrelated store updates.
 */
export function selectStemGroupOfFile(
  state: Pick<State, "stemGroups" | "stemGroupOfFile">,
  fileId: string,
): StemGroup | undefined {
  const groupId = state.stemGroupOfFile[fileId];
  return groupId ? state.stemGroups[groupId] : undefined;
}

/** How a group's method reads in the UI. */
export function stemMethodLabel(method: StemGroupMethod): string {
  switch (method) {
    case "hpss":
      return "HPSS";
    case "ai":
      return "AI stems";
    case "nmf":
      return "NMF";
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
export function getFileSegments(openFileIds: string[], stemGroupOfFile: Record<string, string>): FileSegment[] {
  const segments: FileSegment[] = [];
  for (const fileId of openFileIds) {
    const groupId = stemGroupOfFile[fileId] ?? null;
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

export const createStemGroupsSlice = (set: ZustandSet, get: ZustandGet): StemGroupsState => ({
  stemGroups: {},
  stemGroupOfFile: {},

  createStemGroup: (group) => {
    const id = nextStemGroupId();
    set(
      produce((state: State) => {
        state.stemGroups[id] = { ...group, id, syncView: group.syncView ?? true };
        for (const memberId of group.memberIds) {
          state.stemGroupOfFile[memberId] = id;
        }
      }),
    );
    return id;
  },

  setStemGroupSyncView: (groupId, syncView) => {
    set(
      produce((state: State) => {
        const group = state.stemGroups[groupId];
        if (group) group.syncView = syncView;
      }),
    );
  },

  removeFileFromStemGroup: (fileId) => {
    const groupId = get().stemGroupOfFile[fileId];
    if (!groupId) return;
    set(
      produce((state: State) => {
        delete state.stemGroupOfFile[fileId];
        const group = state.stemGroups[groupId];
        if (!group) return;
        group.memberIds = group.memberIds.filter((id) => id !== fileId);
        if (group.memberIds.length < 2) {
          for (const id of group.memberIds) delete state.stemGroupOfFile[id];
          delete state.stemGroups[groupId];
        }
      }),
    );
  },
});
