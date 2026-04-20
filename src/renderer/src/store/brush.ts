import { getParameterDef, type FileParameterValue } from "@renderer/parameters";
import { aimUvToBrushBlUv } from "@renderer/lib/brush-anchor";
import { BRUSH_ANCHOR_MODE_CENTER } from "@renderer/lib/constants";
import { buildScaleOffsets, minFreqSemisAboveC0, stepScaleSemis } from "@renderer/lib/scale-snap";
import { snapToSwungGridCenter, snapToSwungGridFloor, stepSwungGrid, stepSwungGridCenter } from "@renderer/lib/utils";
import type { ParameterKey } from "./types";
import { openFiles } from "./files";
import type { ZustandGet, ZustandSet } from "./types";

export type StrokePosition = { beats: number; pitch: number };
export type StrokeTimeRange = { min: number; max: number };

export interface BrushState {
  brushIntensity: number;
  brushIterations: number;
  brushPan: number;
  brushSizeTime: number;
  brushCurveTime: number;
  brushSkewTime: number;
  brushSizePitch: number;
  brushCurvePitch: number;
  brushSkewPitch: number;
  brushAnchorMode: number;
  sourceFile: FileParameterValue;
  sourceTimeOffset: number;
  sourcePitchOffset: number;
  sourcePositionMode: string;
  sourceDataMode: string;
  pickingFileParam: ParameterKey | null;
  pickingEffectId: string | null;
  setPickingFileParam: (paramKey: ParameterKey | null, effectId?: string | null) => void;
  highlightedSourcePath: string | null;
  setHighlightedSourcePath: (path: string | null) => void;
  isStroking: boolean;
  setIsStroking: (value: boolean) => void;
  cursorVisible: boolean;
  setCursorVisible: (visible: boolean) => void;
  cursorPosition: StrokePosition | null;
  setCursorPosition: (position: StrokePosition | null) => void;
  // Unified stroke actions
  previewStrokeAtPosition: (position: StrokePosition) => void;
  applyStrokeAtPosition: (position?: StrokePosition, strokeTimeRange?: StrokeTimeRange) => Promise<void>;
  // Helper actions that use the unified ones
  moveBrushPosition: (direction: "up" | "down" | "left" | "right") => void;
  applyBrushAtPosition: () => Promise<void>;
  brushWrapMode: number;
  blendMode: number;
  algorithm: number;
  accumulate: boolean;
}

// Helper to convert position to UV coordinates
function positionToUv(
  position: StrokePosition,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
): { uvX: number; uvY: number; timeSeconds: number } {
  const timeSeconds = (position.beats / bpm) * 60;
  const uvX = timeSeconds / totalDuration;
  const bandsPerSemitone = bandsPerOctave / 12;
  const bandIndex = position.pitch * bandsPerSemitone;
  const uvY = 1 - bandIndex / numBands;
  return { uvX, uvY, timeSeconds };
}

export const createBrushSlice = (set: ZustandSet, get: ZustandGet): BrushState => {
  return {
    brushWrapMode: getParameterDef("brushWrapMode").default,
    brushIntensity: getParameterDef("brushIntensity").default,
    brushIterations: getParameterDef("brushIterations").default,
    brushPan: getParameterDef("brushPan").default,
    brushSizeTime: getParameterDef("brushSizeTime").default,
    brushCurveTime: getParameterDef("brushCurveTime").default,
    brushSkewTime: getParameterDef("brushSkewTime").default,
    brushSizePitch: getParameterDef("brushSizePitch").default,
    brushCurvePitch: getParameterDef("brushCurvePitch").default,
    brushSkewPitch: getParameterDef("brushSkewPitch").default,
    brushAnchorMode: getParameterDef("brushAnchorMode").default,
    blendMode: getParameterDef("blendMode").default,
    algorithm: getParameterDef("algorithm").default,
    accumulate: getParameterDef("accumulate").default,
    sourceFile: null,
    sourceTimeOffset: getParameterDef("sourceTimeOffset").default,
    sourcePitchOffset: getParameterDef("sourcePitchOffset").default,
    sourcePositionMode: getParameterDef("sourcePositionMode").default,
    sourceDataMode: getParameterDef("sourceDataMode").default,
    pickingFileParam: null,
    pickingEffectId: null,
    setPickingFileParam: (paramKey, effectId = null) =>
      set({ pickingFileParam: paramKey, pickingEffectId: paramKey ? effectId : null }),
    highlightedSourcePath: null,
    setHighlightedSourcePath: (path) => set({ highlightedSourcePath: path }),
    isStroking: false,
    setIsStroking: (value) => set({ isStroking: value }),
    cursorVisible: false,
    setCursorVisible: (visible) => set({ cursorVisible: visible }),
    cursorPosition: null,
    setCursorPosition: (position) => set({ cursorPosition: position }),

    // Unified preview action - used by mouse move and arrow keys
    previewStrokeAtPosition: (position) => {
      const state = get();
      const { activeFileId } = state;
      if (!activeFileId) return;

      const file = openFiles[activeFileId];
      if (!file?.rendererRef?.current || !file.spectrogramData) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const { spectrogramData } = file;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      set({ cursorPosition: position, cursorVisible: true });

      const { uvX, uvY } = positionToUv(
        position,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );

      const { blX, blY } = aimUvToBrushBlUv(
        state,
        uvX,
        uvY,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );

      file.rendererRef.current.renderStroke(blX, blY, true);
    },

    // Unified apply action - used by mouse up and Enter key
    applyStrokeAtPosition: async (position?, strokeTimeRange?) => {
      const state = get();
      const { activeFileId, synthesizeFile, autoPlayStroke, setFilePlaybackStartTime, setLoopRegion } = state;

      const effectivePosition = position || state.cursorPosition;
      if (!activeFileId || !effectivePosition) return;

      const file = openFiles[activeFileId];
      if (!file?.rendererRef?.current || !file.spectrogramData) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const { spectrogramData } = file;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const { uvX, uvY } = positionToUv(
        effectivePosition,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );

      // Without a provided strokeTimeRange (e.g. keyboard Enter on a single
      // point), autoplay uses the brush BL time so the loop starts at the
      // stroke onset in either anchor mode.
      const { blX } = aimUvToBrushBlUv(
        state,
        uvX,
        uvY,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );
      const fallbackTimeSeconds = blX * totalDuration;

      // Use provided time range or fall back to single point
      const clampedStart = Math.max(0, strokeTimeRange?.min ?? fallbackTimeSeconds);
      const clampedEnd = Math.min(totalDuration, strokeTimeRange?.max ?? fallbackTimeSeconds);

      let autoPlaybackParams: { startTimeSeconds: number; endTimeSeconds: number } | null = null;
      if (autoPlayStroke) {
        const beatsToSeconds = 60 / bpm;
        const brushDurationSeconds = state.brushSizeTime * beatsToSeconds;

        // Extend time range by brush footprint for autoplay
        const autoPlayStart = clampedStart;
        const autoPlayEnd = Math.min(totalDuration, clampedEnd + brushDurationSeconds);

        setLoopRegion({ start: autoPlayStart, end: autoPlayEnd });
        setFilePlaybackStartTime(activeFileId, autoPlayStart);
        autoPlaybackParams = { startTimeSeconds: autoPlayStart, endTimeSeconds: autoPlayEnd };
      }

      // Get FBO data for synthesis and undo
      const data = await file.rendererRef.current.getFBOData();

      if (data) {
        const { getUndoManager } = await import("@renderer/lib/undo-manager");
        const undoManager = getUndoManager(activeFileId);
        // Run FBO snapshot and synthesis in parallel — same latency as before.
        const dataPathPromise = undoManager.addState(data, activeFileId);

        await synthesizeFile(activeFileId, autoPlaybackParams, data);

        // Cache the synthesised audio for this undo state so redo can skip re-synthesis.
        const dataPath = await dataPathPromise;
        const updated = openFiles[activeFileId];
        if (dataPath && updated?.audioBuffer) {
          undoManager.setStateAudio(dataPath, updated.audioBuffer, updated.audioPeak ?? 1);
        }
      }
    },

    // Helper: move brush and preview
    moveBrushPosition: (direction) => {
      const state = get();
      const {
        cursorPosition,
        gridSizeBeats,
        gridSizeSemis,
        gridSwing,
        activeFileId,
        previewStrokeAtPosition,
        scaleTonic,
        scaleType,
      } = state;

      if (!activeFileId) return;

      const file = openFiles[activeFileId];
      if (!file?.spectrogramData) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const { spectrogramData } = file;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const totalBeats = (totalDuration / 60) * bpm;
      const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
      const totalSemitones = spectrogramData.numBands / bandsPerSemitone;
      const useScale = gridSizeSemis <= 0;

      let currentPos = cursorPosition;

      const swingNorm = gridSwing / 100;
      const step = state.brushes[state.activeBrushIndex]?.steps?.[state.activeStepIndex] as
        | Record<string, unknown>
        | undefined;
      const anchorMode = (step?.brushAnchorMode as number | undefined) ?? state.brushAnchorMode;
      const isCenter = anchorMode === BRUSH_ANCHOR_MODE_CENTER;

      if (!currentPos) {
        // Initializes at the current playback position, snapped to the
        // anchor-mode grid: cell start for corner, cell midpoint for center.
        const playbackTime = state.getPlaybackTime();
        let beats = (playbackTime / 60) * bpm;
        beats = isCenter
          ? snapToSwungGridCenter(beats, gridSizeBeats, swingNorm)
          : snapToSwungGridFloor(beats, gridSizeBeats, swingNorm);
        currentPos = { beats, pitch: 0 };
      }

      // Snaps the stored aim to the anchor-mode grid before stepping so each
      // arrow press lands on the next cell start (corner) or midpoint (center).
      const snappedBeats = isCenter
        ? snapToSwungGridCenter(currentPos.beats, gridSizeBeats, swingNorm)
        : snapToSwungGridFloor(currentPos.beats, gridSizeBeats, swingNorm);
      const snappedPitch = useScale
        ? currentPos.pitch
        : isCenter
          ? (Math.round(currentPos.pitch / gridSizeSemis - 0.5) + 0.5) * gridSizeSemis
          : Math.floor(currentPos.pitch / gridSizeSemis) * gridSizeSemis;

      const newPosition = { beats: snappedBeats, pitch: snappedPitch };
      const minFreqSemis = minFreqSemisAboveC0(spectrogramData.minFreq);
      const offsets = useScale ? buildScaleOffsets(scaleTonic, scaleType) : null;
      switch (direction) {
        case "up":
          if (offsets) {
            const absSemis = minFreqSemis + snappedPitch;
            newPosition.pitch = stepScaleSemis(absSemis, 1, offsets) - minFreqSemis;
          } else {
            newPosition.pitch += gridSizeSemis;
          }
          break;
        case "down":
          if (offsets) {
            const absSemis = minFreqSemis + snappedPitch;
            newPosition.pitch = stepScaleSemis(absSemis, -1, offsets) - minFreqSemis;
          } else {
            newPosition.pitch -= gridSizeSemis;
          }
          break;
        case "left":
          newPosition.beats = isCenter
            ? stepSwungGridCenter(snappedBeats, gridSizeBeats, swingNorm, -1)
            : stepSwungGrid(snappedBeats, gridSizeBeats, swingNorm, -1);
          break;
        case "right":
          newPosition.beats = isCenter
            ? stepSwungGridCenter(snappedBeats, gridSizeBeats, swingNorm, 1)
            : stepSwungGrid(snappedBeats, gridSizeBeats, swingNorm, 1);
          break;
      }

      // Wrap at edges
      if (newPosition.beats < 0) {
        newPosition.beats = snapToSwungGridFloor(totalBeats, gridSizeBeats, swingNorm);
      } else if (newPosition.beats >= totalBeats) {
        newPosition.beats = 0;
      }
      if (newPosition.pitch < 0) {
        newPosition.pitch = useScale ? totalSemitones : Math.floor(totalSemitones / gridSizeSemis) * gridSizeSemis;
      } else if (newPosition.pitch >= totalSemitones) {
        newPosition.pitch = 0;
      }

      previewStrokeAtPosition(newPosition);
    },

    // Helper: apply at current brush position
    applyBrushAtPosition: async () => {
      const { applyStrokeAtPosition } = get();
      await applyStrokeAtPosition();
    },
  };
};
