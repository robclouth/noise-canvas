import type { ZustandSet } from "./types";

/** How far a long job has got. */
export interface JobProgress {
  done: number;
  total: number;
}

export interface EditProgressState {
  /** Set while an edit runs long enough to show how far it has got. */
  editProgress: JobProgress | null;
  /** Shows how far an edit has got, with what stops it, or hides the dialog for null. */
  showEditProgress: (progress: JobProgress | null, cancel?: () => void) => void;
  /** Stops the edit in progress, which takes its stroke back. */
  cancelEdit: () => void;
}

let stopEdit: (() => void) | null = null;

export const createEditProgressSlice = (set: ZustandSet): EditProgressState => ({
  editProgress: null,

  showEditProgress: (progress, cancel) => {
    stopEdit = progress ? (cancel ?? null) : null;
    set({ editProgress: progress });
  },

  cancelEdit: () => {
    stopEdit?.();
  },
});
