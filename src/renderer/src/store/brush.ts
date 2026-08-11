import { getParameterDef, type FileParameterValue } from "@renderer/parameters";
import { conditionStrokeBoundary } from "@renderer/lib/boundary-conditioning";
import { mergePixelRanges } from "@renderer/lib/pixel-ranges";
import { aimUvToBrushBlUv } from "@renderer/lib/brush-anchor";
import { BRUSH_ANCHOR_MODE_CENTER } from "@renderer/lib/constants";
import { buildScaleOffsets, minFreqSemisAboveC0, stepScaleSemis } from "@renderer/lib/scale-snap";
import {
  resolveBrushFootprint,
  snapToSwungGridCenter,
  snapToSwungGridFloor,
  stepSwungGrid,
  stepSwungGridCenter,
} from "@renderer/lib/utils";
import type { ParameterKey } from "./types";
import { openFiles } from "./files";
import type { ZustandGet, ZustandSet } from "./types";
import { getHistoryManager } from "@renderer/lib/history-manager";
import { packOnsetState } from "@renderer/lib/onset-map";
import { useTransientStore } from "./transient";

export type { StrokePosition } from "./transient";
import type { StrokePosition } from "./transient";
export type StrokeTimeRange = { min: number; max: number };

// Serializes stroke commits per file. A commit (history node write + synthesis
// + audio cache) must finish before the next begins, or two commits race the
// HistoryManager's currentPacked/currentId — forking the history tree and
// mismatching delta bases — and the file's audio buffer. Painting itself is
// never blocked; only the post-stroke commit tail is queued behind the prior one.
const strokeCommitChains = new Map<string, Promise<unknown>>();

function serializeStrokeCommit<T>(fileId: string, task: () => Promise<T>): Promise<T> {
  const prev = strokeCommitChains.get(fileId) ?? Promise.resolve();
  const result = prev.then(task);
  // The chain tail must never reject, or one failed commit would wedge the
  // queue. Drop the entry once it drains so the map doesn't grow unbounded.
  const tail = result.then(
    () => {
      if (strokeCommitChains.get(fileId) === tail) strokeCommitChains.delete(fileId);
    },
    () => {
      if (strokeCommitChains.get(fileId) === tail) strokeCommitChains.delete(fileId);
    },
  );
  strokeCommitChains.set(fileId, tail);
  return result;
}

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

      useTransientStore.setState({ cursorPosition: position, cursorVisible: true });

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

      const effectivePosition = position || useTransientStore.getState().cursorPosition;
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
        // Active-step brush size overrides the global — match what the stroke
        // actually paints, so the loop region covers the true brush footprint
        // (and not just the grid when the global is in Grid mode but the step
        // overrides to a wider size).
        const activeStep = state.brushes[state.activeBrushIndex]?.steps?.[state.activeStepIndex] as
          | Record<string, unknown>
          | undefined;
        const stepBrushSizeTime = (activeStep?.brushSizeTime as number | undefined) ?? state.brushSizeTime;
        const stepBrushSizePitch = (activeStep?.brushSizePitch as number | undefined) ?? state.brushSizePitch;
        const autoplayFootprint = resolveBrushFootprint({
          brushSizeTime: stepBrushSizeTime,
          brushSizePitch: stepBrushSizePitch,
          gridSizeBeats: state.gridSizeBeats,
          gridSizeSemis: state.gridSizeSemis,
          bpm,
          totalDuration,
          bandsPerOctave: spectrogramData.bandsPerOctave,
          numBands: spectrogramData.numBands,
        });
        const brushDurationSeconds = autoplayFootprint.fullTime
          ? totalDuration
          : autoplayFootprint.sizeUv.x * totalDuration;

        // Extend time range by brush footprint for autoplay
        const autoPlayStart = clampedStart;
        const autoPlayEnd = Math.min(totalDuration, clampedEnd + brushDurationSeconds);

        setLoopRegion({ start: autoPlayStart, end: autoPlayEnd });
        setFilePlaybackStartTime(activeFileId, autoPlayStart);
        autoPlaybackParams = { startTimeSeconds: autoPlayStart, endTimeSeconds: autoPlayEnd };
      }

      // Capture the brush footprint and issue the FBO readback before queueing
      // the commit. getFBOData() issues the GPU read synchronously, so the
      // snapshot reflects this stroke's end even though the commit body runs
      // serialized behind any earlier stroke.
      const renderer = file.rendererRef.current;
      const dirtyRanges = renderer.getDirtyPixelRanges();
      const dataPromise = renderer.getFBOData();
      const spec = file.spectrogramData;
      const brushName = state.brushes[state.activeBrushIndex]?.name ?? "Stroke";
      const dimensions = {
        textureWidth: spec.textureWidth,
        textureHeight: spec.textureHeight,
        numFrames: spec.numFrames,
        numBands: spec.numBands,
        numChannels: spec.numChannels,
        sampleRate: spec.sampleRate,
        minFreq: spec.minFreq,
        bandsPerOctave: spec.bandsPerOctave,
      };

      await serializeStrokeCommit(activeFileId, async () => {
        const data = await dataPromise;
        if (!data) return;

        // Hard-edged strokes get their time boundaries rewritten to the
        // time-domain-exact edit before history and synthesis consume the
        // data, so what is stored, shown, and heard all carry the conditioned
        // boundary. Failure or a stale stroke just keeps the plain edges.
        let historyDirtyRanges = dirtyRanges;
        try {
          const patched = await conditionStrokeBoundary(renderer, spec, state, data);
          if (patched && historyDirtyRanges) {
            historyDirtyRanges = mergePixelRanges(historyDirtyRanges, patched);
          }
        } catch (error) {
          console.error("Boundary conditioning failed; committing plain stroke:", error);
        }

        const historyManager = getHistoryManager(activeFileId);
        // Run history node write and synthesis in parallel.
        const nodeIdPromise = historyManager.addStroke({
          data,
          label: brushName,
          dimensions,
          dirtyRanges: historyDirtyRanges,
        });

        await synthesizeFile(activeFileId, autoPlaybackParams, data);

        const nodeId = await nodeIdPromise;
        const updated = openFiles[activeFileId];
        if (nodeId && updated?.audioBuffer) {
          historyManager.setStateAudio(nodeId, updated.audioBuffer, updated.audioPeak ?? 1);
        }
        // Stored against the state the stroke made, so coming back to it later
        // restores the onsets of what it painted rather than finding them again.
        if (nodeId && updated?.onsets) {
          void historyManager
            .setNodeOnsets(nodeId, packOnsetState({ onsets: updated.onsets, reference: updated.onsetReference }))
            .catch((error) => console.error("Storing onsets for history node failed:", error));
        }
      });
    },

    // Helper: move brush and preview
    moveBrushPosition: (direction) => {
      const state = get();
      const { gridSizeBeats, gridSizeSemis, gridSwing, activeFileId, previewStrokeAtPosition, scaleTonic, scaleType } =
        state;
      const { cursorPosition } = useTransientStore.getState();

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
            ? stepSwungGridCenter(currentPos.beats, gridSizeBeats, swingNorm, -1)
            : stepSwungGrid(currentPos.beats, gridSizeBeats, swingNorm, -1);
          break;
        case "right":
          newPosition.beats = isCenter
            ? stepSwungGridCenter(currentPos.beats, gridSizeBeats, swingNorm, 1)
            : stepSwungGrid(currentPos.beats, gridSizeBeats, swingNorm, 1);
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
      const state = get();
      const { activeFileId, applyStrokeAtPosition } = state;
      const { cursorPosition } = useTransientStore.getState();
      if (!activeFileId || !cursorPosition) return;

      const file = openFiles[activeFileId];
      if (!file?.rendererRef?.current || !file.spectrogramData) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const { spectrogramData } = file;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const { uvX, uvY } = positionToUv(
        cursorPosition,
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

      // Arrow keys render the stroke as a preview; committing it requires a
      // non-preview render before the synthesis/undo step.
      file.rendererRef.current.beginStroke();
      file.rendererRef.current.renderStroke(blX, blY, false);
      await applyStrokeAtPosition();
      file.rendererRef.current.endStroke();
    },
  };
};
