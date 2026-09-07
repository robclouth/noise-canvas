import { notifications } from "@mantine/notifications";
import { diag } from "@renderer/lib/diag-log";
import type { FileRendererHandle, StrokeDispatch } from "@renderer/components/file-renderer";
import { resolveGridFill, type GridFillTarget } from "@renderer/lib/grid/grid-fill";
import { activeLoopRegion, openFiles } from "./files";
import type { State, ZustandGet, ZustandSet } from "./types";

/** Fills larger than this paint in chunks, behind a progress dialog you can cancel. */
export const FILL_PROGRESS_THRESHOLD = 256;

/** Strokes painted between yields to the browser. */
const FILL_CHUNK = 256;

export interface FillProgress {
  done: number;
  total: number;
}

export interface FillState {
  isFilling: boolean;
  /** Set while a large fill paints, which is the only time the dialog shows. */
  fillProgress: FillProgress | null;
  /** Asks the running fill to stop and put back the pixels from before it. */
  cancelFill: () => void;
  /** Paints the active brush on every grid cell, as one stroke and one history step. */
  fillGrid: () => Promise<void>;
}

let cancelRequested = false;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Everything a fill needs from the active file, or null when one isn't paintable. */
function resolveTarget(state: State) {
  const { activeFileId } = state;
  if (!activeFileId) return null;
  const file = openFiles[activeFileId];
  const renderer = file?.rendererRef?.current;
  const spectrogramData = file?.spectrogramData;
  if (!renderer || !spectrogramData) return null;

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
    set({ isFilling: true });
    let renderer: FileRendererHandle | null = null;
    try {
      const resolved = resolveTarget(get());
      if (!resolved) return;
      renderer = resolved.renderer;
      const { target } = resolved;

      const { anchors, state: painted } = resolveGridFill(get(), target);
      if (anchors.length === 0) return;

      // Saves the pixels from before the pass, so cancelling puts them back.
      renderer.beginStrokePreview();

      const total = anchors.length;
      const showProgress = total > FILL_PROGRESS_THRESHOLD;
      if (showProgress) set({ fillProgress: { done: 0, total } });

      let strokesPainted = 0;
      let settleMs = 0;
      const paintStart = performance.now();
      for (let start = 0; start < total; start += FILL_CHUNK) {
        const chunk: StrokeDispatch[] = anchors
          .slice(start, start + FILL_CHUNK)
          .map((anchor) => ({ aimX: anchor.aimX, aimY: anchor.aimY, state: painted }));
        strokesPainted += renderer.renderStrokeBatch(chunk);
        // A canvas holding a window of the file takes the chunk's strokes as
        // the window reaches them, so each chunk lands before the next is given.
        const settleStart = performance.now();
        await renderer.settleStroke();
        settleMs += performance.now() - settleStart;
        if (showProgress) {
          set({ fillProgress: { done: Math.min(start + FILL_CHUNK, total), total } });
          await nextFrame();
        }
        if (cancelRequested) {
          await renderer.discardStrokePreview();
          return;
        }
      }
      diag.timing("timing", "fill grid painted", performance.now() - paintStart, {
        strokes: strokesPainted,
        settleMs: Math.round(settleMs),
      });
      if (strokesPainted === 0) {
        await renderer.discardStrokePreview();
        return;
      }

      // The painted pixels become the commit: one history node, one resynthesis.
      renderer.keepStrokePreview();
      const region = target.region;
      await get().applyStrokeAtPosition(
        { beats: 0, pitch: 0 },
        { min: region?.start ?? 0, max: region?.end ?? target.totalDuration },
        "Fill Grid",
        false,
      );
    } finally {
      renderer?.endStroke();
      cancelRequested = false;
      set({ isFilling: false, fillProgress: null });
    }
  },
});
