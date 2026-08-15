import type { StrokeDispatch } from "@renderer/components/file-renderer";
import { resolveGridFill, type GridFillTarget } from "@renderer/lib/grid/grid-fill";
import { activeLoopRegion, openFiles } from "./files";
import type { State, ZustandGet, ZustandSet } from "./types";

/** Fills larger than this paint in chunks, behind a progress dialog you can cancel. */
export const FILL_PROGRESS_THRESHOLD = 256;

/** Strokes painted between yields to the browser. */
const FILL_CHUNK = 64;

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

    cancelRequested = false;
    set({ isFilling: true });
    try {
      const resolved = resolveTarget(get());
      if (!resolved) return;
      const { renderer, target } = resolved;

      const { anchors, state: painted } = resolveGridFill(get(), target);
      if (anchors.length === 0) return;

      // Saves the pixels from before the pass, so cancelling puts them back.
      renderer.beginStrokePreview();

      const total = anchors.length;
      const showProgress = total > FILL_PROGRESS_THRESHOLD;
      if (showProgress) set({ fillProgress: { done: 0, total } });

      let strokesPainted = 0;
      for (let start = 0; start < total; start += FILL_CHUNK) {
        const chunk: StrokeDispatch[] = anchors
          .slice(start, start + FILL_CHUNK)
          .map((anchor) => ({ blX: anchor.blX, blY: anchor.blY, state: painted }));
        strokesPainted += renderer.renderStrokeBatch(chunk);
        if (!showProgress) continue;

        set({ fillProgress: { done: Math.min(start + FILL_CHUNK, total), total } });
        await nextFrame();
        if (cancelRequested) {
          renderer.discardStrokePreview();
          return;
        }
      }
      if (strokesPainted === 0) {
        renderer.discardStrokePreview();
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
      renderer.endStroke();
    } finally {
      cancelRequested = false;
      set({ isFilling: false, fillProgress: null });
    }
  },
});
