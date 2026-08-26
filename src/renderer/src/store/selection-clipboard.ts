import { DEFAULT_ONSET_SENSITIVITY } from "@renderer/lib/constants";
import { serializeFileTask } from "@renderer/lib/file-task-queue";
import { getHistoryManager } from "@renderer/lib/history-manager";
import type { Selection } from "@renderer/lib/selection";
import {
  buildClipboardRegion,
  clipboardSourceOffset,
  dropRect,
  type ClipboardRegion,
} from "@renderer/lib/selection-clip";
import { pasteStrokeState, regionAim, silenceStrokeState, type StrokeGeometry } from "@renderer/lib/selection-strokes";
import type { SourceFileInfo } from "@renderer/lib/stroke-renderer";
import { openFiles } from "./files";
import type { OpenFile, State, ZustandGet, ZustandSet } from "./types";

/** The path a paste step names, standing in for a file that is not open. */
export const CLIPBOARD_PATH = "clipboard://selection";

/**
 * The copied region. One clipboard for the whole app, held outside the store
 * because nothing renders from it and it is the size of what was copied.
 */
let clipboard: ClipboardRegion | null = null;

/**
 * The clipboard's GPU textures while a region is in flight. Held across the
 * drag so a pointer move redraws the preview without rebuilding them.
 */
let placingSource: SourceFileInfo | null = null;

/** A region in flight: picked up, following the pointer, not yet put down. */
export interface PlacingState {
  fileId: string;
  /** Where the region lands if it is dropped now. */
  rect: Selection;
  /** The region to silence when the drop lands. Null for a copy or a paste. */
  vacate: Selection | null;
  label: string;
}

export interface SelectionClipboardState {
  placing: PlacingState | null;
  /** Copy the active file's selection and pick it up; the original stays. */
  copySelection: () => Promise<void>;
  /** Copy the active file's selection and pick it up; the original goes when it lands. */
  cutSelection: () => Promise<void>;
  /** Silence the active file's selection. */
  silenceSelection: () => Promise<void>;
  /** Pick the clipboard up so it follows the pointer, starting at `aim` when given. */
  beginPaste: (aim?: { timeSeconds: number; pitchUv: number }) => void;
  /** Pick the active file's selection up, leaving a copy behind or not. */
  beginMove: (copy: boolean) => Promise<void>;
  /** Move what is in flight to a new corner, in the file's seconds and pitch UV. */
  movePlacing: (timeSeconds: number, pitchUv: number) => void;
  /** Put down what is in flight, as one edit. */
  dropPlacing: () => Promise<void>;
  /** Put down nothing and keep the clipboard. */
  cancelPlacing: () => void;
}

interface EditTarget {
  fileId: string;
  file: OpenFile;
  geometry: StrokeGeometry;
  state: State;
}

function target(get: ZustandGet, fileId?: string): EditTarget | null {
  const state = get();
  const id = fileId ?? state.activeFileId;
  if (!id) return null;
  const file = openFiles[id];
  if (!file?.spectrogramData || !file.rendererRef?.current) return null;
  if (state.filesLoading[id] || state.filesBusy[id]) return null;

  const spec = file.spectrogramData;
  return {
    fileId: id,
    file,
    geometry: {
      bpm: state.filepathsBpm[file.filePath] || 120,
      totalDuration: spec.numFrames / spec.sampleRate,
      spec,
    },
    state,
  };
}

function activeSelectionOf(get: ZustandGet, edit: EditTarget | null): Selection | null {
  return edit ? (get().filesSelection[edit.fileId] ?? null) : null;
}

/** Reads `selection` off the canvas into the clipboard. */
async function copyRegion(edit: EditTarget, selection: Selection): Promise<boolean> {
  const renderer = edit.file.rendererRef?.current;
  if (!renderer) return false;

  return serializeFileTask(edit.fileId, async () => {
    await getHistoryManager(edit.fileId).awaitPackedReaders();
    const data = await renderer.getFBOData();
    if (!data) return false;
    const region = buildClipboardRegion(
      data,
      selection,
      edit.geometry.spec,
      edit.file.displayName,
      edit.file.onsets,
      edit.state.filepathsOnsetSensitivity[edit.file.filePath] ?? DEFAULT_ONSET_SENSITIVITY,
    );
    if (!region) return false;
    clipboard = region;
    return true;
  });
}

function openPlacingSource(edit: EditTarget): void {
  const renderer = edit.file.rendererRef?.current;
  if (!renderer || !clipboard || placingSource) return;
  placingSource = renderer.createRegionSource(
    CLIPBOARD_PATH,
    clipboard.spec,
    clipboard.onsets,
    clipboard.onsetSensitivity,
  );
}

function closePlacingSource(fileId: string): void {
  const renderer = openFiles[fileId]?.rendererRef?.current;
  if (placingSource && renderer) renderer.disposeRegionSource(placingSource);
  placingSource = null;
}

/** Draws what is in flight over the canvas, without committing it. */
function previewPlacing(edit: EditTarget, placing: PlacingState): void {
  const renderer = edit.file.rendererRef?.current;
  if (!renderer || !clipboard || !placingSource) return;
  const offset = clipboardSourceOffset(clipboard);
  const state = pasteStrokeState(edit.state, placing.rect, edit.geometry, {
    path: CLIPBOARD_PATH,
    timeFraction: offset.timeFraction,
    pitchFraction: offset.pitchFraction,
  });
  renderer.renderRegionStroke({ ...regionAim(placing.rect, edit.geometry), state, source: placingSource }, true);
}

/**
 * Paints `states` over `regions` as one edit: one preview batch, one history
 * node, one resynthesis, through the same commit pass a brush stroke uses. That
 * is what makes a wiped edge exact in the time domain rather than a hard cut in
 * the coefficients.
 */
async function commitRegionStrokes(
  edit: EditTarget,
  strokes: { state: State; rect: Selection }[],
  label: string,
  get: ZustandGet,
): Promise<void> {
  const renderer = edit.file.rendererRef?.current;
  if (!renderer || strokes.length === 0) return;

  const source = placingSource;
  renderer.beginStroke();
  try {
    let painted = 0;
    for (const stroke of strokes) {
      const aim = regionAim(stroke.rect, edit.geometry);
      if (renderer.renderRegionStroke({ ...aim, state: stroke.state, source: source ?? undefined }, false)) painted++;
    }
    if (painted === 0) return;

    const start = Math.min(...strokes.map((s) => s.rect.start));
    const end = Math.max(...strokes.map((s) => s.rect.end));
    await get().applyStrokeAtPosition({ beats: 0, pitch: 0 }, { min: start, max: end }, label, false);
  } finally {
    renderer.endStroke();
  }
}

export const createSelectionClipboardSlice = (set: ZustandSet, get: ZustandGet): SelectionClipboardState => ({
  placing: null,

  copySelection: async () => {
    await get().beginMove(true);
  },

  cutSelection: async () => {
    await get().beginMove(false);
  },

  silenceSelection: async () => {
    const edit = target(get);
    const selection = activeSelectionOf(get, edit);
    if (!edit || !selection) return;
    await commitRegionStrokes(
      edit,
      [{ state: silenceStrokeState(edit.state, selection, edit.geometry), rect: selection }],
      "Silence",
      get,
    );
  },

  beginPaste: (aim) => {
    const edit = target(get);
    if (!edit || !clipboard) return;
    const selection = activeSelectionOf(get, edit);
    // The ghost starts under the pointer when it is over the canvas. When it is
    // not — a paste from the menu bar — it starts where the last selection was.
    const from = aim ? { start: aim.timeSeconds, pitchLo: aim.pitchUv } : (selection ?? clipboard.rect);
    const placing: PlacingState = {
      fileId: edit.fileId,
      rect: dropRect(clipboard, from.start, from.pitchLo),
      vacate: null,
      label: "Paste",
    };
    openPlacingSource(edit);
    set({ placing });
    previewPlacing(edit, placing);
  },

  beginMove: async (copy) => {
    const edit = target(get);
    const selection = activeSelectionOf(get, edit);
    if (!edit || !selection) return;
    if (!(await copyRegion(edit, selection))) return;
    const placing: PlacingState = {
      fileId: edit.fileId,
      rect: selection,
      vacate: copy ? null : selection,
      label: copy ? "Paste" : "Move",
    };
    openPlacingSource(edit);
    set({ placing });
    previewPlacing(edit, placing);
  },

  movePlacing: (timeSeconds, pitchUv) => {
    const current = get().placing;
    if (!current || !clipboard) return;
    const rect = dropRect(clipboard, timeSeconds, pitchUv);
    if (rect.start === current.rect.start && rect.pitchLo === current.rect.pitchLo) return;
    const placing = { ...current, rect };
    set({ placing });
    const edit = target(get, placing.fileId);
    if (edit) previewPlacing(edit, placing);
  },

  dropPlacing: async () => {
    const placing = get().placing;
    if (!placing || !clipboard) return;
    const edit = target(get, placing.fileId);
    if (!edit) {
      set({ placing: null });
      closePlacingSource(placing.fileId);
      return;
    }
    // The landed rectangle becomes the selection before the placing state goes,
    // so the overlay never falls back to the old selection while the commit
    // runs.
    get().setFileSelection(placing.fileId, placing.rect);
    set({ placing: null });
    edit.file.rendererRef?.current?.clearPreview();

    const offset = clipboardSourceOffset(clipboard);
    const strokes: { state: State; rect: Selection }[] = [];
    // The paste samples the clipboard, not the canvas, so vacating first cannot
    // take the sound with it — and a drop overlapping its own origin keeps what
    // it just wrote.
    if (placing.vacate) {
      strokes.push({ state: silenceStrokeState(edit.state, placing.vacate, edit.geometry), rect: placing.vacate });
    }
    strokes.push({
      state: pasteStrokeState(edit.state, placing.rect, edit.geometry, {
        path: CLIPBOARD_PATH,
        timeFraction: offset.timeFraction,
        pitchFraction: offset.pitchFraction,
      }),
      rect: placing.rect,
    });

    await commitRegionStrokes(edit, strokes, placing.label, get);
    closePlacingSource(placing.fileId);
  },

  cancelPlacing: () => {
    const placing = get().placing;
    if (!placing) return;
    set({ placing: null });
    closePlacingSource(placing.fileId);
    openFiles[placing.fileId]?.rendererRef?.current?.clearPreview();
  },
});

export function getSelectionClipboard(): ClipboardRegion | null {
  return clipboard;
}
