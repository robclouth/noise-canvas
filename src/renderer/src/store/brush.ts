import { getParameterDef, type FileParameterValue } from "@renderer/parameters";
import { notifications } from "@mantine/notifications";
import { applyCoefficientPatch } from "@renderer/lib/coef-patch";
import { buildStrokeCommitSnapshot } from "@renderer/lib/stroke-commit";
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
  unitsToUv,
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
  applyStrokeAtPosition: (
    position?: StrokePosition,
    strokeTimeRange?: StrokeTimeRange,
    label?: string,
  ) => Promise<void>;
  // Helper actions that use the unified ones
  moveBrushPosition: (direction: "up" | "down" | "left" | "right") => void;
  applyBrushAtPosition: () => Promise<void>;
  brushWrapMode: number;
  blendMode: number;
  algorithm: number;
  accumulate: boolean;
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

      useTransientStore.setState({ cursorPosition: position, cursorVisible: true });
      file.rendererRef.current.renderStroke(true);
    },

    // Unified apply action - used by mouse up and Enter key
    applyStrokeAtPosition: async (position?, strokeTimeRange?, label?) => {
      const state = get();
      const { activeFileId, commitStroke, autoPlayStroke, setFilePlaybackStartTime, setLoopRegion } = state;

      const effectivePosition = position || useTransientStore.getState().cursorPosition;
      if (!activeFileId || !effectivePosition) return;

      const file = openFiles[activeFileId];
      if (!file?.rendererRef?.current || !file.spectrogramData) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const { spectrogramData } = file;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const aim = unitsToUv(
        effectivePosition.beats,
        effectivePosition.pitch,
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
        aim.x,
        aim.y,
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

      // Take everything the commit reads from the renderer, and issue the FBO
      // readback, before queueing. getFBOData() issues the GPU read
      // synchronously, so the snapshot reflects this stroke's end even though
      // the commit body runs serialized behind any earlier stroke.
      const renderer = file.rendererRef.current;
      const snapshot = buildStrokeCommitSnapshot({
        renderer,
        state,
        spec: file.spectrogramData,
        brushName: label ?? state.brushes[state.activeBrushIndex]?.name ?? "Stroke",
        autoPlaybackParams,
      });
      const dataPromise = renderer.getFBOData();

      await serializeStrokeCommit(activeFileId, async () => {
        const data = await dataPromise;
        if (!data) return;

        try {
          // One pass derives the audio and the coefficients that audio
          // analyses to, so what is stored, shown and heard are the same
          // thing. Anything less than all of it is a bug, not a fallback.
          const result = await commitStroke(activeFileId, snapshot, data);
          if (!result) return;

          let historyDirtyRanges = snapshot.dirtyRanges;
          const extent = applyCoefficientPatch(
            data,
            result.patch,
            snapshot.spec.synthesisMetadata.bandOffsets,
            snapshot.spec.synthesisMetadata.bandStepLog2s,
          );
          if (extent) {
            // The projection reaches past the painted rect, so the delta must
            // cover it too or undo would store stale margins.
            historyDirtyRanges = historyDirtyRanges
              ? mergePixelRanges(historyDirtyRanges, extent.pixelRanges)
              : extent.pixelRanges;
            // A new stroke started while this one was in flight; its dabs are
            // not in `data`, so uploading would paint over them. The audio and
            // history are still right for this stroke, and the next commit
            // re-projects the union.
            if (renderer.getStrokeGeneration() === snapshot.strokeGeneration) {
              const uploadStart = performance.now();
              renderer.patchFBOData(data, extent.pixelRanges);
              console.log(`[timing] commit FBO upload: ${(performance.now() - uploadStart).toFixed(2)}ms`);
            }
          }

          const historyManager = getHistoryManager(activeFileId);
          const node = await historyManager.addStroke({
            data,
            label: snapshot.brushName,
            dimensions: snapshot.dimensions,
            dirtyRanges: historyDirtyRanges,
          });

          const updated = openFiles[activeFileId];
          // A stroke that changed nothing gets no node, and the id that comes
          // back is its parent's — whose caches already belong to it.
          if (node.isNew && updated?.audioBuffer) {
            historyManager.setStateAudio(node.id, updated.audioBuffer, updated.audioPeak ?? 1);
          }
          // Stored against the state the stroke made, so coming back to it later
          // restores the onsets of what it painted rather than finding them again.
          if (node.isNew && updated?.onsets) {
            void historyManager
              .setNodeOnsets(node.id, packOnsetState({ onsets: updated.onsets, reference: updated.onsetReference }))
              .catch((error) => console.error("Storing onsets for history node failed:", error));
          }
        } catch (error) {
          console.error("Committing the stroke failed:", error);
          notifications.show({
            color: "red",
            title: "Stroke not committed",
            message: "The canvas, the audio and the history may disagree. Undo to get back to a state that holds.",
          });
          // The canvas on the GPU is no longer known to match the history, so
          // the next navigation restores in full rather than by delta.
          getHistoryManager(activeFileId).markFboOutOfSync();
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

      // Arrow keys render the stroke as a preview; committing it requires a
      // non-preview render before the synthesis/undo step.
      file.rendererRef.current.beginStroke();
      file.rendererRef.current.renderStroke(false);
      await applyStrokeAtPosition();
      file.rendererRef.current.endStroke();
    },
  };
};
