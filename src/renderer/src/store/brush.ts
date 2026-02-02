import { getParameterDef } from "@renderer/parameters";
import { openFiles } from "./files";
import type { ZustandGet, ZustandSet } from "./types";

export type StrokePosition = { beats: number; pitch: number };
export type StrokeTimeRange = { min: number; max: number };

export interface BrushState {
  brushIntensity: number;
  brushIterations: number;
  brushPan: number;
  brushEnvelopeDelayTime: number;
  brushEnvelopeAttackTime: number;
  brushEnvelopeSustainTime: number;
  brushEnvelopeReleaseTime: number;
  brushEnvelopeDelayPitch: number;
  brushEnvelopeAttackPitch: number;
  brushEnvelopeSustainPitch: number;
  brushEnvelopeReleasePitch: number;
  sourcePosition: { beats: number; pitch: number; fileId: string } | null;
  setSourcePosition: (position: { beats: number; pitch: number; fileId: string } | null) => void;
  sourcePositionMode: string;
  sourceDataMode: string;
  isSettingPosition: boolean;
  setIsSettingPosition: (value: boolean) => void;
  cursorVisible: boolean;
  setCursorVisible: (visible: boolean) => void;
  cursorPosition: StrokePosition | null;
  setCursorPosition: (position: StrokePosition | null) => void;
  lockedOffset: StrokePosition | null;
  setLockedOffset: (offset: StrokePosition | null) => void;
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
    brushEnvelopeDelayTime: getParameterDef("brushEnvelopeDelayTime").default,
    brushEnvelopeAttackTime: getParameterDef("brushEnvelopeAttackTime").default,
    brushEnvelopeSustainTime: getParameterDef("brushEnvelopeSustainTime").default,
    brushEnvelopeReleaseTime: getParameterDef("brushEnvelopeReleaseTime").default,
    brushEnvelopeDelayPitch: getParameterDef("brushEnvelopeDelayPitch").default,
    brushEnvelopeAttackPitch: getParameterDef("brushEnvelopeAttackPitch").default,
    brushEnvelopeSustainPitch: getParameterDef("brushEnvelopeSustainPitch").default,
    brushEnvelopeReleasePitch: getParameterDef("brushEnvelopeReleasePitch").default,
    blendMode: getParameterDef("blendMode").default,
    algorithm: getParameterDef("algorithm").default,
    accumulate: getParameterDef("accumulate").default,
    sourcePositionMode: getParameterDef("sourcePositionMode").default,
    sourceDataMode: getParameterDef("sourceDataMode").default,
    sourcePosition: null,
    setSourcePosition: (position) => set({ sourcePosition: position, lockedOffset: null }),
    isSettingPosition: false,
    setIsSettingPosition: (value: boolean) => set({ isSettingPosition: value }),
    cursorVisible: false,
    setCursorVisible: (visible) => set({ cursorVisible: visible }),
    cursorPosition: null,
    setCursorPosition: (position) => set({ cursorPosition: position }),
    lockedOffset: null,
    setLockedOffset: (offset) => set({ lockedOffset: offset }),

    // Unified preview action - used by mouse move and arrow keys
    previewStrokeAtPosition: (position) => {
      const state = get();
      const { activeFileId } = state;
      if (!activeFileId) return;

      const file = openFiles[activeFileId];
      if (!file?.rendererRef?.current) return;

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

      file.rendererRef.current.renderStroke(uvX, uvY, true);
    },

    // Unified apply action - used by mouse up and Enter key
    applyStrokeAtPosition: async (position?, strokeTimeRange?) => {
      const state = get();
      const { activeFileId, synthesizeFile, autoPlayStroke, setFilePlaybackStartTime, setAutoPlayEndTime } = state;

      const effectivePosition = position || state.cursorPosition;
      if (!activeFileId || !effectivePosition) return;

      const file = openFiles[activeFileId];
      if (!file?.rendererRef?.current) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const { spectrogramData } = file;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const { timeSeconds } = positionToUv(
        effectivePosition,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );

      // Small delay to let any pending render complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Get FBO data and create undo state
      const data = await file.rendererRef.current.getFBOData();
      if (data) {
        const { getUndoManager } = await import("@renderer/lib/undo-manager");
        const undoManager = getUndoManager(activeFileId);
        await undoManager.addState(data, activeFileId);

        // Use provided time range or fall back to single point
        const clampedStart = Math.max(0, strokeTimeRange?.min ?? timeSeconds);
        const clampedEnd = Math.min(totalDuration, strokeTimeRange?.max ?? timeSeconds);

        let autoPlaybackParams: { startTimeSeconds: number; endTimeSeconds: number } | null = null;
        if (autoPlayStroke) {
          // Get envelope times in beats and convert to seconds
          const {
            brushEnvelopeDelayTime,
            brushEnvelopeAttackTime,
            brushEnvelopeSustainTime,
            brushEnvelopeReleaseTime,
          } = state;
          const beatsToSeconds = 60 / bpm;
          const delaySeconds = brushEnvelopeDelayTime * beatsToSeconds;
          const envelopeEndSeconds =
            (brushEnvelopeAttackTime + brushEnvelopeSustainTime + brushEnvelopeReleaseTime) * beatsToSeconds;

          // Extend time range by envelope times for autoplay
          const autoPlayStart = Math.max(0, clampedStart - delaySeconds);
          const autoPlayEnd = Math.min(totalDuration, clampedEnd + envelopeEndSeconds);

          setFilePlaybackStartTime(activeFileId, autoPlayStart);
          setAutoPlayEndTime(autoPlayEnd);
          autoPlaybackParams = { startTimeSeconds: autoPlayStart, endTimeSeconds: autoPlayEnd };
        }

        await synthesizeFile(activeFileId, autoPlaybackParams);
      }
    },

    // Helper: move brush and preview
    moveBrushPosition: (direction) => {
      const state = get();
      const { cursorPosition, gridSizeBeats, gridSizeSemis, activeFileId, previewStrokeAtPosition } = state;

      if (!activeFileId) return;

      const file = openFiles[activeFileId];
      if (!file) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const { spectrogramData } = file;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const totalBeats = (totalDuration / 60) * bpm;
      const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
      const totalSemitones = spectrogramData.numBands / bandsPerSemitone;

      let currentPos = cursorPosition;

      if (!currentPos) {
        // Initialize to playback position, snapped to grid
        const playbackTime = state.getPlaybackTime();
        let beats = (playbackTime / 60) * bpm;
        // Snap to grid
        beats = Math.floor(beats / gridSizeBeats) * gridSizeBeats;
        currentPos = { beats, pitch: 0 };
      }

      // Snap current position to grid first
      const snappedBeats = Math.floor(currentPos.beats / gridSizeBeats) * gridSizeBeats;
      const snappedPitch = Math.floor(currentPos.pitch / gridSizeSemis) * gridSizeSemis;

      const newPosition = { beats: snappedBeats, pitch: snappedPitch };
      switch (direction) {
        case "up":
          newPosition.pitch += gridSizeSemis;
          break;
        case "down":
          newPosition.pitch -= gridSizeSemis;
          break;
        case "left":
          newPosition.beats -= gridSizeBeats;
          break;
        case "right":
          newPosition.beats += gridSizeBeats;
          break;
      }

      // Wrap at edges
      if (newPosition.beats < 0) {
        newPosition.beats = Math.floor(totalBeats / gridSizeBeats) * gridSizeBeats;
      } else if (newPosition.beats >= totalBeats) {
        newPosition.beats = 0;
      }
      if (newPosition.pitch < 0) {
        newPosition.pitch = Math.floor(totalSemitones / gridSizeSemis) * gridSizeSemis;
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
