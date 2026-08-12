import type { StampDispatch } from "@renderer/components/file-renderer";
import { GENERATE_PRESETS } from "@renderer/lib/generate/presets";
import {
  resolveStampLayout,
  resolveStampMarkers,
  type StampMarker,
  type StampTarget,
} from "@renderer/lib/generate/stamp-layout";
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

  const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
  const target: StampTarget = {
    spectrogramData,
    bpm: state.filepathsBpm[file.filePath] || 120,
    totalDuration: spectrogramData.numFrames / spectrogramData.sampleRate,
    // Without a cursor to aim from, stamps land halfway up the file.
    basePitch: useTransientStore.getState().cursorPosition?.pitch ?? spectrogramData.numBands / bandsPerSemitone / 2,
  };
  return { fileId: activeFileId, renderer, target };
}

/**
 * Where the active file's pass would land, without painting it. The canvas
 * overlay calls this on every keystroke; `paintPreview` places the same stamps
 * through the same code when typing pauses, so a drawn block and a painted
 * stamp cannot disagree. Throws the pattern's own error.
 */
export function activeStampMarkers(state: State): StampMarker[] {
  const resolved = resolveTarget(state);
  if (!resolved) return [];
  return resolveStampMarkers(state, resolved.target);
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
    const resolved = resolveTarget(state);
    if (!resolved) return null;
    const { fileId, renderer, target } = resolved;

    const dispatches: StampDispatch[] = resolveStampLayout(state, target).map((stamp) => ({
      blX: stamp.blX,
      blY: stamp.blY,
      state: stamp.state,
    }));

    if (dispatches.length === 0) {
      discardPreview();
      return null;
    }

    // Saves the pre-preview pixels on the first call, restores them on later
    // ones, so each preview replaces the last instead of layering onto it.
    renderer.beginStampPreview();
    set({ generatePreviewFileId: fileId });

    const painted = renderer.renderStampBatch(dispatches);
    if (painted === 0) {
      discardPreview();
      return null;
    }
    return { basePitch: target.basePitch, totalDuration: target.totalDuration, fileId };
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
        const pass = paintPreview();
        if (!pass) return;

        const file = openFiles[pass.fileId];
        const renderer = file?.rendererRef?.current;
        if (!renderer) return;

        // The previewed pixels become the commit: one history node, one resynthesis.
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
