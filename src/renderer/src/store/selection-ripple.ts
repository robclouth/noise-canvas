import { notifications } from "@mantine/notifications";
import { produce } from "immer";
import type { AnalysisParams } from "../../../main/lib/types";
import { host } from "../lib/host";
import { insertSpan, removeSpan } from "../lib/ripple-edits";

const SPLICE_FADE_SECONDS = 0.005;
import { fullHeightSelection, selectionFrameRange } from "../lib/selection";
import type { ClipboardRegion } from "../lib/selection-clip";
import { getSelectionClipboard } from "./selection-clipboard";
import { openFiles, readCurrentPackedData, rebuildFileFromAudio } from "./files";
import type { OpenFile, State, ZustandGet, ZustandSet } from "./types";

export interface SelectionRippleState {
  /** Cut the selection's stretch of time out of the file, closing the gap. */
  cutTimeSelection: () => Promise<void>;
  /** Splice the clipboard's stretch of time in, pushing what follows later. */
  pasteTimeSelection: () => Promise<void>;
  /** Splice a copy of the selection's stretch in, directly after it. */
  duplicateTimeSelection: () => Promise<void>;
}

interface RippleTarget {
  fileId: string;
  file: OpenFile;
  sampleRate: number;
  duration: number;
}

function target(get: ZustandGet): RippleTarget | null {
  const state = get();
  const fileId = state.activeFileId;
  if (!fileId) return null;
  const file = openFiles[fileId];
  if (!file?.spectrogramData) return null;
  if (state.filesLoading[fileId] || state.filesBusy[fileId]) return null;
  const { sampleRate, numFrames } = file.spectrogramData;
  return { fileId, file, sampleRate, duration: numFrames / sampleRate };
}

/**
 * Runs one time splice: read the painted state, resynthesise, rewrite the
 * channels, re-analyse — the same road Insert Silence takes, so the edit is a
 * true sample splice rather than a coefficient cut. The view stays on screen
 * throughout; `filesBusy` badges it and holds pointer input off.
 */
async function rippleRebuild(
  set: ZustandSet,
  edit: RippleTarget,
  message: string,
  label: string,
  transform: (channels: Float32Array[]) => Float32Array[],
): Promise<boolean> {
  const packedData = await readCurrentPackedData(edit.file);

  set(
    produce((state: State) => {
      state.filesBusy[edit.fileId] = message;
    }),
  );
  try {
    await rebuildFileFromAudio(set, edit.fileId, async () => packedData, transform, { kind: "resize", label });
    return true;
  } catch (error) {
    console.error(`${label} failed:`, error);
    notifications.show({
      title: `${label} failed`,
      message: error instanceof Error ? error.message : "Unknown error",
      color: "red",
    });
    return false;
  } finally {
    set(
      produce((state: State) => {
        delete state.filesBusy[edit.fileId];
      }),
    );
  }
}

/** The clipboard's copied span as audio channels, synthesised from its own coefficients. */
async function clipboardSpanAudio(clipboard: ClipboardRegion): Promise<Float32Array[] | null> {
  const { spec } = clipboard;
  const analysisParams: AnalysisParams = {
    bandsPerOctave: spec.bandsPerOctave,
    minFreq: spec.minFreq,
  };
  const result = await host.analysis.synthesize(
    spec.packedData,
    {
      numFrames: spec.numFrames,
      numChannels: spec.numChannels,
      numBands: spec.numBands,
      bandOffsets: spec.synthesisMetadata.bandOffsets,
      bandStepLog2s: spec.synthesisMetadata.bandStepLog2s,
      bandLengths: spec.synthesisMetadata.bandLengths,
    },
    spec.sampleRate,
    analysisParams,
    false,
  );
  if (!result?.channels?.length) return null;

  const { startFrame, endFrame } = selectionFrameRange(clipboard.rect, spec.sampleRate);
  const from = Math.max(0, startFrame - clipboard.originFrame);
  const to = Math.min(result.channels[0].length, endFrame - clipboard.originFrame);
  if (to <= from) return null;
  return result.channels.map((channel) => channel.slice(from, to));
}

export const createSelectionRippleSlice = (set: ZustandSet, get: ZustandGet): SelectionRippleState => ({
  cutTimeSelection: async () => {
    const edit = target(get);
    const selection = edit ? (get().filesSelection[edit.fileId] ?? null) : null;
    if (!edit || !selection) return;
    const widened = fullHeightSelection(selection.start, selection.end);
    if (!widened) return;

    // A ripple cut takes the full column of time with it, whatever height was
    // drawn, so the clipboard holds what the file loses.
    if (!(await get().stashSelection(widened))) return;

    const startSample = widened.start * edit.sampleRate;
    const endSample = widened.end * edit.sampleRate;
    const fade = Math.round(SPLICE_FADE_SECONDS * edit.sampleRate);
    const done = await rippleRebuild(set, edit, "Cutting time...", "Cut time", (channels) =>
      removeSpan(channels, startSample, endSample, fade),
    );
    if (done) {
      const newDuration = edit.duration - (widened.end - widened.start);
      get().setFilePlaybackStartTime(edit.fileId, Math.max(0, Math.min(widened.start, newDuration)));
    }
  },

  pasteTimeSelection: async () => {
    const edit = target(get);
    const clipboard = getSelectionClipboard();
    if (!edit || !clipboard) return;

    // The splice lands at the selection when there is one, else at the play
    // start marker.
    const selection = get().filesSelection[edit.fileId] ?? null;
    const at = Math.max(0, Math.min(edit.duration, selection?.start ?? get().filesPlaybackStartTime[edit.fileId] ?? 0));
    const insert = await clipboardSpanAudio(clipboard);
    if (!insert) return;
    const spanSeconds = (insert[0]?.length ?? 0) / clipboard.spec.sampleRate;

    const fade = Math.round(SPLICE_FADE_SECONDS * edit.sampleRate);
    const done = await rippleRebuild(set, edit, "Pasting time...", "Paste time", (channels) =>
      insertSpan(channels, at * edit.sampleRate, insert, fade),
    );
    if (done) {
      get().setFileSelection(edit.fileId, fullHeightSelection(at, at + spanSeconds));
      get().setFilePlaybackStartTime(edit.fileId, at);
    }
  },

  duplicateTimeSelection: async () => {
    const edit = target(get);
    const selection = edit ? (get().filesSelection[edit.fileId] ?? null) : null;
    if (!edit || !selection) return;
    const widened = fullHeightSelection(selection.start, selection.end);
    if (!widened) return;

    const startSample = Math.round(widened.start * edit.sampleRate);
    const endSample = Math.round(widened.end * edit.sampleRate);
    const fade = Math.round(SPLICE_FADE_SECONDS * edit.sampleRate);
    const done = await rippleRebuild(set, edit, "Duplicating time...", "Duplicate time", (channels) =>
      insertSpan(
        channels,
        endSample,
        channels.map((channel) => channel.slice(startSample, endSample)),
        fade,
      ),
    );
    if (done) {
      const span = widened.end - widened.start;
      get().setFileSelection(edit.fileId, fullHeightSelection(widened.end, widened.end + span));
      get().setFilePlaybackStartTime(edit.fileId, widened.end);
    }
  },
});
