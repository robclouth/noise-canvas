import type { StampDispatch } from "@renderer/components/file-renderer";
import { aimUvToBrushBlUv } from "@renderer/lib/brush-anchor";
import { BEATS_PER_CYCLE, evaluatePattern, queryStamps } from "@renderer/lib/generate/pattern-engine";
import { GENERATE_PRESETS } from "@renderer/lib/generate/presets";
import { resolveBrushToken } from "@renderer/lib/generate/resolve-brush";
import { buildStampState, type ResolvedStamp } from "@renderer/lib/generate/stamp-state";
import { positionToUv } from "./brush";
import { openFiles } from "./files";
import { useTransientStore } from "./transient";
import type { State, ZustandGet, ZustandSet } from "./types";

export const GENERATE_PERSISTED_KEYS = ["generateCode"] as const;

export interface GenerateState {
  /** Pattern source shown in the Generate panel. */
  generateCode: string;
  /** Selects which window of the pattern's randomness is used. */
  generateSeed: number;
  isGenerating: boolean;
  /** File currently showing an uncommitted preview, if any. */
  generatePreviewFileId: string | null;
  setGenerateCode: (code: string) => void;
  setGenerateSeed: (seed: number) => void;
  /** Paints the pattern across the active file without committing it. */
  previewGenerate: () => void;
  /** Commits the previewed pass as one stroke, one history node, one resynthesis. */
  runGenerate: () => Promise<void>;
  /** Picks a new seed and previews again. */
  rerollGenerate: () => void;
  /** Takes back an uncommitted preview. */
  discardGeneratePreview: () => void;
}

/** Everything a pass needs from the active file, or null when one isn't paintable. */
function resolveTarget(state: State) {
  const { activeFileId } = state;
  if (!activeFileId) return null;
  const file = openFiles[activeFileId];
  const renderer = file?.rendererRef?.current;
  const spectrogramData = file?.spectrogramData;
  if (!renderer || !spectrogramData) return null;

  const bpm = state.filepathsBpm[file.filePath] || 120;
  const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
  return { fileId: activeFileId, renderer, spectrogramData, bpm, totalDuration };
}

export const createGenerateSlice = (set: ZustandSet, get: ZustandGet): GenerateState => {
  const discardPreview = () => {
    const { generatePreviewFileId } = get();
    if (!generatePreviewFileId) return;
    openFiles[generatePreviewFileId]?.rendererRef?.current?.discardStampPreview();
    set({ generatePreviewFileId: null });
  };

  /**
   * Stamps the pattern across the file, over the pixels held before any earlier
   * preview. Throws the pattern's own error when it doesn't parse.
   */
  const paintPreview = (): { basePitch: number; totalDuration: number; fileId: string } | null => {
    const state = get();
    const target = resolveTarget(state);
    if (!target) return null;
    const { fileId, renderer, spectrogramData, bpm, totalDuration } = target;

    const fileBeats = (totalDuration / 60) * bpm;
    const cycles = Math.max(1, Math.ceil(fileBeats / BEATS_PER_CYCLE));
    const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
    // Without a cursor to aim from, stamps land halfway up the file.
    const basePitch =
      useTransientStore.getState().cursorPosition?.pitch ?? spectrogramData.numBands / bandsPerSemitone / 2;

    const events = queryStamps(evaluatePattern(state.generateCode), cycles, state.generateSeed);

    const dispatches: StampDispatch[] = [];
    for (const event of events) {
      if (event.beats >= fileBeats) continue;

      const resolved: ResolvedStamp = {
        ...event,
        brushIndex: resolveBrushToken(event.brushToken, state.brushes) ?? state.activeBrushIndex,
        pitchSemis: basePitch + event.semis,
      };
      const stampState = buildStampState(state, resolved);

      const { uvX, uvY } = positionToUv(
        { beats: resolved.beats, pitch: resolved.pitchSemis },
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );
      // Anchor conversion reads the stamp's own brush size and anchor mode, so
      // it must see the per-stamp state rather than the live one.
      const { blX, blY } = aimUvToBrushBlUv(
        stampState,
        uvX,
        uvY,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );
      dispatches.push({ blX, blY, state: stampState });
    }

    if (dispatches.length === 0) {
      discardPreview();
      return null;
    }

    // Saves the pre-preview pixels on the first call and restores them on every
    // later one, so each preview replaces the last instead of layering onto it.
    renderer.beginStampPreview();
    set({ generatePreviewFileId: fileId });

    const painted = renderer.renderStampBatch(dispatches);
    if (painted === 0) {
      discardPreview();
      return null;
    }
    return { basePitch, totalDuration, fileId };
  };

  return {
    generateCode: GENERATE_PRESETS[0].code,
    generateSeed: 0,
    isGenerating: false,
    generatePreviewFileId: null,

    setGenerateCode: (code) => set({ generateCode: code }),
    setGenerateSeed: (seed) => set({ generateSeed: seed }),
    discardGeneratePreview: discardPreview,

    previewGenerate: () => {
      if (get().isGenerating) return;
      try {
        paintPreview();
      } catch (error) {
        discardPreview();
        throw error;
      }
    },

    rerollGenerate: () => {
      if (get().isGenerating) return;
      set({ generateSeed: Math.floor(Math.random() * 1_000_000) });
      get().previewGenerate();
    },

    runGenerate: async () => {
      if (get().isGenerating) return;

      set({ isGenerating: true });
      try {
        // Repainting from the saved pixels makes Apply independent of whatever
        // preview happens to be on screen.
        const pass = paintPreview();
        if (!pass) return;

        const file = openFiles[pass.fileId];
        const renderer = file?.rendererRef?.current;
        if (!renderer) return;

        // The preview's pixels become the commit, so the whole pass lands as one
        // history node and one resynthesis.
        renderer.keepStampPreview();
        set({ generatePreviewFileId: null });
        await get().applyStrokeAtPosition(
          { beats: 0, pitch: pass.basePitch },
          { min: 0, max: pass.totalDuration },
          "Generate",
        );
        renderer.endStroke();
      } catch (error) {
        discardPreview();
        throw error;
      } finally {
        set({ isGenerating: false });
      }
    },
  };
};
