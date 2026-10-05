import { notifications } from "@mantine/notifications";
import { diag } from "@renderer/lib/diag-log";
import type { FileRendererHandle, StrokeDispatch } from "@renderer/lib/file-renderer-types";
import { resolveGridFill, type GridFillTarget } from "@renderer/lib/grid/grid-fill";
import { isOnsetGrid } from "@renderer/lib/constants";
import { beginStrokeWhenFree } from "@renderer/lib/stroke-begin";
import {
  DAB_NOT_TAKEN,
  FILE_OPENING,
  STROKE_LOCKED,
  showNothingPainted,
  showPiecesSkipped,
} from "@renderer/lib/stroke-notices";
import type { JobProgress } from "./edit-progress";
import { activeLoopRegion, openFiles } from "./files";
import type { State, ZustandGet, ZustandSet } from "./types";

/** Fills larger than this paint in chunks, behind a progress dialog you can cancel. */
export const FILL_PROGRESS_THRESHOLD = 256;

/** Strokes painted between yields to the browser. */
const FILL_CHUNK = 256;

export interface FillState {
  isFilling: boolean;
  /** Set while a large fill paints, which is the only time the dialog shows. */
  fillProgress: JobProgress | null;
  /** Asks the running fill to stop and put back the pixels from before it. */
  cancelFill: () => void;
  /** Paints the active brush on every grid cell, as one stroke and one history step. */
  fillGrid: () => Promise<void>;
}

let cancelRequested = false;
let fillAbort: AbortController | null = null;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Why a fill finds no cells on the grid it was given. */
function noCellsReason(state: State): string {
  const looped = activeLoopRegion(state) !== null;
  if (state.snapTime && isOnsetGrid(state.gridSizeBeats))
    return looped
      ? "No onsets fall inside the loop region. Move the loop or pick a beat grid."
      : "This file has no onsets to fill between. Pick a beat grid.";
  return looped
    ? "The loop region holds no grid cells. Widen the loop or make the grid finer."
    : "The grid has no cells on this file.";
}

/** Everything a fill needs from the active file. */
type FillTarget = { fileId: string; renderer: FileRendererHandle; target: GridFillTarget };

/** Everything a fill needs from the active file, or why it cannot paint one. */
function resolveTarget(state: State): FillTarget | { reason: string } {
  const { activeFileId } = state;
  if (!activeFileId) return { reason: "Open a file first." };
  const file = openFiles[activeFileId];
  const renderer = file?.rendererRef?.current;
  const spectrogramData = file?.spectrogramData;
  if (!renderer || !spectrogramData) return { reason: FILE_OPENING };

  const target: GridFillTarget = {
    fileId: activeFileId,
    spectrogramData,
    bpm: state.filepathsBpm[file.filePath] || 120,
    totalDuration: spectrogramData.numFrames / spectrogramData.sampleRate,
    region: activeLoopRegion(state),
  };
  return { fileId: activeFileId, renderer, target };
}

export const createFillSlice = (set: ZustandSet, get: ZustandGet): FillState => ({
  isFilling: false,
  fillProgress: null,

  cancelFill: () => {
    cancelRequested = true;
    fillAbort?.abort();
  },

  fillGrid: async () => {
    if (get().isFilling) return;

    // With both axes unsnapped the grid is one cell covering the whole file, so
    // the fill would be a single full-canvas stroke.
    if (!get().snapTime && !get().snapPitch) {
      notifications.show({
        title: "Nothing to fill",
        message: "Turn on time snapping or pitch snapping to give the fill a grid.",
        color: "yellow",
      });
      return;
    }

    cancelRequested = false;
    fillAbort = new AbortController();
    set({ isFilling: true });
    let renderer: FileRendererHandle | null = null;
    let started = false;
    try {
      const resolved = resolveTarget(get());
      if ("reason" in resolved) {
        showNothingPainted(resolved.reason);
        return;
      }
      renderer = resolved.renderer;
      const { target } = resolved;

      const { anchors, state: painted } = resolveGridFill(get(), target);
      if (anchors.length === 0) {
        showNothingPainted(noCellsReason(get()));
        return;
      }

      // Saves the pixels from before the pass, so cancelling puts them back.
      if (!(await beginStrokeWhenFree(renderer))) {
        showNothingPainted(STROKE_LOCKED);
        return;
      }
      started = true;

      const total = anchors.length;
      const showProgress = total > FILL_PROGRESS_THRESHOLD;
      if (showProgress) set({ fillProgress: { done: 0, total } });

      let strokesPainted = 0;
      let refused: StrokeDispatch | null = null;
      let settleMs = 0;
      const paintStart = performance.now();
      for (let start = 0; start < total; start += FILL_CHUNK) {
        const dispatch = (from: number, to: number): StrokeDispatch[] =>
          anchors.slice(from, to).map((anchor) => ({ aimX: anchor.aimX, aimY: anchor.aimY, state: painted }));
        const chunk = dispatch(start, start + FILL_CHUNK);
        const ahead = dispatch(start + FILL_CHUNK, start + 2 * FILL_CHUNK);
        const batch = renderer.renderStrokeBatch(chunk, ahead);
        strokesPainted += batch.painted;
        refused ??= batch.refused;
        // A canvas holding a window of the file takes the chunk's strokes as
        // the window reaches them, so each chunk lands before the next is given.
        const settleStart = performance.now();
        const result = await renderer.settleStroke(fillAbort.signal);
        if (result.status !== "completed") return;
        settleMs += performance.now() - settleStart;
        if (showProgress) {
          set({ fillProgress: { done: Math.min(start + FILL_CHUNK, total), total } });
          await nextFrame();
        }
        if (cancelRequested || get().activeFileId !== resolved.fileId) {
          await renderer.discardStrokePreview();
          return;
        }
      }
      diag.timing("timing", "fill grid painted", performance.now() - paintStart, {
        strokes: strokesPainted,
        settleMs: Math.round(settleMs),
      });
      const skipped = total - strokesPainted;
      if (skipped > 0) {
        const reason = refused
          ? (renderer.strokeRefusal(refused.state, { x: refused.aimX, y: refused.aimY }) ?? DAB_NOT_TAKEN)
          : DAB_NOT_TAKEN;
        showPiecesSkipped("Fill Grid", skipped, total, "cells", reason);
      }
      if (strokesPainted === 0) {
        await renderer.discardStrokePreview();
        return;
      }

      // The painted pixels become the commit: one history node, one resynthesis.
      const region = target.region;
      await get().applyStrokeAtPosition(
        { beats: 0, pitch: 0 },
        { min: region?.start ?? 0, max: region?.end ?? target.totalDuration },
        "Fill Grid",
        false,
      );
    } finally {
      if (started) renderer?.endStroke();
      cancelRequested = false;
      fillAbort = null;
      set({ isFilling: false, fillProgress: null });
    }
  },
});
