import { serializeFileTask } from "@renderer/lib/file-task-queue";
import { getHistoryManager } from "@renderer/lib/history-manager";
import * as Tone from "tone";
import type { AnalysisParams } from "../../../main/lib/types";
import { host } from "../lib/host";
import { readPackedSpan } from "../lib/packed-span";
import { isFullHeight, selectionFrameRange, type Selection } from "../lib/selection";
import { buildClipboardRegion } from "../lib/selection-clip";
import { getFileSynthesisGeneration, openFiles } from "./files";
import type { ZustandGet, ZustandSet } from "./types";

export interface SelectionAuditionState {
  /** True while playback sounds a band-limited selection's own audio. */
  selectionAudition: boolean;
  /**
   * The selection's own audio: its bands synthesised alone, silent outside its
   * time span, at the file's full length so player time stays file time. Null
   * for a full-height selection, which sounds the same as the file itself.
   */
  selectionAuditionBuffer: (fileId: string, selection: Selection) => Promise<AudioBuffer | null>;
  /** Re-aims running playback at the file's current selection, debounced. */
  retargetSelectionAudition: (fileId: string) => void;
  /**
   * Re-masks a commit's fresh audio for the running audition and swaps it in,
   * keeping the selection's window on the player.
   */
  remaskPlayingBuffer: (fresh: AudioBuffer) => void;
}

let cache: { fileId: string; rect: Selection; generation: number; buffer: AudioBuffer } | null = null;
let retargetTimer: ReturnType<typeof setTimeout> | null = null;

function sameRect(a: Selection, b: Selection): boolean {
  return (
    a.start === b.start && a.end === b.end && a.pitchLo === b.pitchLo && a.pitchHi === b.pitchHi && a.mask === b.mask
  );
}

function cached(fileId: string, rect: Selection): AudioBuffer | null {
  if (!cache || cache.fileId !== fileId || !sameRect(cache.rect, rect)) return null;
  if (cache.generation !== getFileSynthesisGeneration(fileId)) return null;
  return cache.buffer;
}

/**
 * Points the running player at the file's current selection: the masked buffer
 * and the selection's time window, or the file's own buffer and loop region
 * when the selection is gone.
 */
async function applyRetarget(fileId: string, get: ZustandGet, set: ZustandSet): Promise<void> {
  const state = get();
  if (!state.isPlaying || state.activeFileId !== fileId) return;
  const file = openFiles[fileId];
  if (!file?.audioBuffer) return;
  const selection = state.filesSelection[fileId] ?? null;

  if (!selection) {
    if (!state.selectionAudition) return;
    set({ selectionAudition: false });
    get().swapPlayingBufferRaw(file.audioBuffer);
    applyWindow(get, set, state.filesLoopRegion[fileId] ?? null, false);
    return;
  }

  const masked = await get().selectionAuditionBuffer(fileId, selection);
  const after = get();
  if (!after.isPlaying || after.activeFileId !== fileId) return;
  if ((after.filesSelection[fileId] ?? null) !== selection) return;

  const wasAudition = after.selectionAudition;
  set({ selectionAudition: masked !== null });
  if (masked) get().swapPlayingBufferRaw(masked);
  else if (wasAudition) get().swapPlayingBufferRaw(file.audioBuffer);
  applyWindow(get, set, { start: selection.start, end: selection.end }, true);
}

/** Moves the running player's loop window, restarting at its start when asked. */
function applyWindow(
  get: ZustandGet,
  set: ZustandSet,
  region: { start: number; end: number } | null,
  restart: boolean,
): void {
  const { player, isPlaying } = get();
  if (!isPlaying || !player) return;
  const duration = player.buffer?.duration ?? 0;
  const loopStart = region?.start ?? 0;
  const loopEnd = region?.end ?? duration;

  if (region) {
    set({ loop: true });
    player.loop = true;
  }
  player.loopStart = loopStart;
  player.loopEnd = loopEnd;
  if (restart && region) player.restart(Tone.now(), loopStart);

  set((s) => ({
    playerClock: {
      ...s.playerClock,
      ...(restart && region ? { startAt: Tone.now(), startOffset: loopStart } : {}),
      loopStart,
      loopEnd,
    },
  }));
}

export const createSelectionAuditionSlice = (set: ZustandSet, get: ZustandGet): SelectionAuditionState => ({
  selectionAudition: false,

  selectionAuditionBuffer: async (fileId, selection) => {
    if (isFullHeight(selection)) return null;
    const file = openFiles[fileId];
    const spec = file?.spectrogramData;
    if (!file || !spec) return null;
    const hit = cached(fileId, selection);
    if (hit) return hit;

    return serializeFileTask(fileId, async () => {
      await getHistoryManager(fileId).awaitPackedReaders();
      const generation = getFileSynthesisGeneration(fileId);
      const settled = cached(fileId, selection);
      if (settled) return settled;

      const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
      const span = await readPackedSpan(spec, startFrame, endFrame, (ranges) =>
        getHistoryManager(fileId).currentRanges(ranges),
      );
      if (!span) return null;
      const clip = buildClipboardRegion(span, selection, spec, file.displayName);
      if (!clip?.spec.packedData) return null;

      const analysisParams: AnalysisParams = {
        bandsPerOctave: spec.bandsPerOctave,
        minFreq: spec.minFreq,
      };
      const result = await host.analysis.synthesize(
        clip.spec.packedData,
        {
          numFrames: clip.spec.numFrames,
          numChannels: clip.spec.numChannels,
          numBands: clip.spec.numBands,
          bandOffsets: clip.spec.synthesisMetadata.bandOffsets,
          bandStepLog2s: clip.spec.synthesisMetadata.bandStepLog2s,
          bandLengths: clip.spec.synthesisMetadata.bandLengths,
        },
        spec.sampleRate,
        analysisParams,
        false,
      );
      if (!result?.channels?.length) return null;

      const context = Tone.getContext().rawContext;
      const buffer = context.createBuffer(spec.numChannels, spec.numFrames, spec.sampleRate);
      for (let ch = 0; ch < Math.min(spec.numChannels, result.channels.length); ch++) {
        const channel = result.channels[ch];
        const span = Math.min(channel.length, spec.numFrames - clip.originFrame);
        if (span > 0) buffer.getChannelData(ch).set(channel.subarray(0, span), clip.originFrame);
      }
      cache = { fileId, rect: selection, generation, buffer };
      return buffer;
    });
  },

  retargetSelectionAudition: (fileId) => {
    const { isPlaying, activeFileId } = get();
    if (!isPlaying || activeFileId !== fileId) return;
    if (retargetTimer !== null) clearTimeout(retargetTimer);
    retargetTimer = setTimeout(() => {
      retargetTimer = null;
      void applyRetarget(fileId, get, set);
    }, 250);
  },

  remaskPlayingBuffer: (fresh) => {
    const { activeFileId } = get();
    const selection = activeFileId ? (get().filesSelection[activeFileId] ?? null) : null;
    if (!activeFileId || !selection) {
      get().swapPlayingBufferRaw(fresh);
      return;
    }
    void get()
      .selectionAuditionBuffer(activeFileId, selection)
      .then((masked) => {
        if (!get().isPlaying) return;
        get().swapPlayingBufferRaw(masked ?? fresh);
        // The raw swap rebuilds the player window from the stored loop region,
        // which knows nothing of the selection; put the window back, restarting
        // only when playback has escaped it.
        const position = get().getPlaybackTime();
        const inside = position >= selection.start && position < selection.end;
        applyWindow(get, set, { start: selection.start, end: selection.end }, !inside);
      });
  },
});
