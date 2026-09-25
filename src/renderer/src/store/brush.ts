import { getParameterDef, type FileParameterValue } from "@renderer/parameters";
import { notifications } from "@mantine/notifications";
import { applyCoefficientPatch } from "@renderer/lib/coef-patch";
import { diag } from "@renderer/lib/diag-log";
import { setCanvasPatchStash, takeCanvasPatchStash } from "@renderer/lib/canvas-patch-stash";
import { serializeFileTask } from "@renderer/lib/file-task-queue";
import { buildStrokeCommitSnapshot, projectsWholeFile } from "@renderer/lib/stroke-commit";
import {
  composePixelRangeValues,
  copyCompactOverlap,
  gatherPixelRanges,
  mergePixelRanges,
  pixelRangeCount,
  scatterCompactPixelRanges,
  subtractPixelRanges,
} from "@renderer/lib/pixel-ranges";
import { applyCanvasTurns, type CanvasTurn, type PackedGather } from "@renderer/lib/canvas-phase-turns";
import { applyPhaseTurns, hasPhaseTurns } from "../../../main/lib/history-delta";
import { brushUnionForAim } from "@renderer/lib/brush-anchor";
import { BRUSH_ANCHOR_MODE_CENTER } from "@renderer/lib/constants";
import { buildScaleOffsets, minFreqSemisAboveC0, stepScaleSemis } from "@renderer/lib/scale-snap";
import {
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
    /** False leaves the transport alone; the new buffer still swaps in. */
    autoPlay?: boolean,
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
    applyStrokeAtPosition: async (position?, strokeTimeRange?, label?, autoPlay = true) => {
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
      // stroke onset in either anchor mode. Brush size and anchor mode are
      // per-step, so the loop covers the steps' rectangles together.
      const brushUnion = brushUnionForAim(
        state,
        aim.x,
        aim.y,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );
      const fallbackTimeSeconds = brushUnion.blX * totalDuration;

      // Use provided time range or fall back to single point
      const clampedStart = Math.max(0, strokeTimeRange?.min ?? fallbackTimeSeconds);
      const clampedEnd = Math.min(totalDuration, strokeTimeRange?.max ?? fallbackTimeSeconds);

      let autoPlaybackParams: { startTimeSeconds: number; endTimeSeconds: number } | null = null;
      if (autoPlayStroke && autoPlay) {
        const brushDurationSeconds = brushUnion.fullTime ? totalDuration : brushUnion.sizeUvX * totalDuration;

        // Extend time range by brush footprint for autoplay
        const autoPlayStart = clampedStart;
        const autoPlayEnd = Math.min(totalDuration, clampedEnd + brushDurationSeconds);

        setLoopRegion({ start: autoPlayStart, end: autoPlayEnd });
        setFilePlaybackStartTime(activeFileId, autoPlayStart);
        autoPlaybackParams = { startTimeSeconds: autoPlayStart, endTimeSeconds: autoPlayEnd };
      }

      // Take everything the commit reads from the renderer, and issue the
      // footprint readback, before queueing: the read is issued synchronously,
      // so it reflects this stroke's end even though the commit body runs
      // serialized behind any earlier stroke.
      const renderer = file.rendererRef.current;
      const snapshot = buildStrokeCommitSnapshot({
        renderer,
        state,
        spec: file.spectrogramData,
        brushName: label ?? state.brushes[state.activeBrushIndex]?.name ?? "Stroke",
        autoPlaybackParams,
        hasUnprojectedPaint: file.unprojectedPaint === true,
      });
      // A stroke changes the packed state inside its footprint, and a
      // projection inside its window and as whole phase turns past it — so
      // only the footprint is read back, and the rest of the state stays in
      // the block store. A commit that rebuilds the whole file takes the
      // store's whole state with the stroke's pixels over it.
      const historyManager = getHistoryManager(activeFileId);
      const currentIdBefore = historyManager.getCurrentId();
      const painted = snapshot.dirtyRanges != null && snapshot.dirtyRanges.length > 0 ? snapshot.dirtyRanges : null;
      const footprintOnly = !projectsWholeFile(snapshot) && painted != null;
      const paintedRead = painted ? renderer.readPixelRanges(painted) : null;
      // The store does not hold this stroke until the commit lands, so the
      // canvas keeps the paint on any block it brings in meanwhile.
      const releasePaint = painted && paintedRead ? renderer.holdPaint(painted, paintedRead) : null;

      const commitTask = serializeFileTask(activeFileId, async () => {
        const readStart = performance.now();
        const paintedValues = paintedRead ? await paintedRead : null;
        // A navigation's synthesis may still be landing — the commit measures
        // against the audio it installs — and may still be reading the packed
        // state this commit writes into.
        await historyManager.awaitPackedReaders();
        if (!openFiles[activeFileId]) return;
        if (!historyManager.movedOnlyByStrokes(currentIdBefore)) {
          // A reanalysis or a history move replaced the state the stroke was
          // painted on, so its pixels no longer describe any part of it.
          console.warn("history: the state moved under the stroke; it was not committed");
          return;
        }

        let data: Float32Array | null = null;
        let baseFootprint: Float32Array | undefined;
        let footprint: { ranges: Uint32Array; values: Float32Array } | null = null;
        if (footprintOnly && painted && paintedValues) {
          // The store holds the pre-stroke state, stashed pixels included.
          baseFootprint = (await historyManager.currentRanges(painted)) ?? undefined;
          if (baseFootprint) footprint = { ranges: painted, values: paintedValues };
        } else if (!footprintOnly) {
          data = await historyManager.currentBlockState();
          if (data && painted && paintedValues) scatterCompactPixelRanges(data, paintedValues, painted);
        }
        if (!footprint && !data) {
          console.warn("history: the store could not serve the stroke's commit");
          return;
        }
        diag.timing("timing", "commit state read", performance.now() - readStart, {
          footprintOnly: footprintOnly ? 1 : 0,
        });

        // A patch an earlier commit could not upload, because this stroke was
        // already on the canvas when it landed. Its pixels live in the block
        // store; the ones this stroke painted are left out, because the older
        // patch describes the canvas before them.
        const stash = takeCanvasPatchStash(activeFileId);
        const stashRanges =
          stash && snapshot.dirtyRanges
            ? subtractPixelRanges(stash.ranges, snapshot.dirtyRanges)
            : (stash?.ranges ?? null);

        try {
          // One pass derives the audio and the coefficients that audio
          // analyses to, so what is stored, shown and heard are the same
          // thing. Anything less than all of it is a bug, not a fallback.
          const outcome = await commitStroke(activeFileId, snapshot, { data, footprint });
          if (!outcome) return;
          const { result } = outcome;
          // The commit read the whole canvas itself when the store fell short.
          if (outcome.data) data = outcome.data;

          let historyDirtyRanges = snapshot.dirtyRanges;
          if (!data && result.patch.pixels) throw new Error("the commit returned pixels without a whole state");
          const extent = applyCoefficientPatch(
            data ?? new Float32Array(0),
            result.patch,
            snapshot.spec.synthesisMetadata.bandOffsets,
            snapshot.spec.synthesisMetadata.bandStepLog2s,
          );
          // A host that hands the patch back as pixels did not write the turns
          // into this copy either.
          const turns = hasPhaseTurns(result.tail) ? result.tail : null;
          if (data && turns && result.patch.pixels) applyPhaseTurns(data, turns, false);
          if (extent) {
            // The projection reaches past the painted rect, so the delta must
            // cover it too or undo would store stale margins.
            historyDirtyRanges = historyDirtyRanges
              ? mergePixelRanges(historyDirtyRanges, extent.pixelRanges)
              : extent.pixelRanges;
            if (baseFootprint && snapshot.dirtyRanges) {
              // The delta compares against what the merged ranges held before
              // the stroke: the saved footprint, and around it the values the
              // projection replaced.
              if (!result.patch.previous) throw new Error("the commit did not keep the values its patch replaced");
              baseFootprint = composePixelRangeValues(historyDirtyRanges, [
                { ranges: snapshot.dirtyRanges, values: baseFootprint },
                { ranges: extent.pixelRanges, values: result.patch.previous },
              ]);
            }
          }

          // A footprint commit's painted values over the merged ranges. The
          // commit changes the view only where its patch and turns say, so
          // with neither they are the pixels read at pen-up; otherwise they
          // are cut from the view the commit worked on.
          let afterFootprint: Float32Array | undefined;
          if (!data && footprint && !extent && !turns) {
            afterFootprint = footprint.values;
          } else if (!data && outcome.view && outcome.viewBuffer && historyDirtyRanges) {
            afterFootprint = new Float32Array(pixelRangeCount(historyDirtyRanges) * 4);
            copyCompactOverlap(afterFootprint, historyDirtyRanges, outcome.viewBuffer, outcome.view.ranges);
          }
          if (!data && !afterFootprint) throw new Error("the commit produced no state to store");

          const historyStart = performance.now();
          const node = await historyManager.addStroke({
            data: data ?? undefined,
            label: snapshot.brushName,
            dimensions: snapshot.dimensions,
            dirtyRanges: historyDirtyRanges,
            audioRegion: projectsWholeFile(snapshot) ? null : snapshot.dirtyRegion,
            unprojectedPaint: openFiles[activeFileId]?.unprojectedPaint === true,
            baseFootprint,
            afterFootprint,
            turns: turns ?? undefined,
          });
          diag.timing("timing", "commit history add", performance.now() - historyStart, { whole: data ? 1 : 0 });

          // The turns go on the canvas as an operation; the window pixels and
          // any stashed ones are uploaded from the state — the whole readback
          // when there is one, the block store's tier otherwise, which holds
          // the stroke now that it is stored.
          let uploadRanges = extent ? extent.pixelRanges : null;
          if (stashRanges) uploadRanges = uploadRanges ? mergePixelRanges(stashRanges, uploadRanges) : stashRanges;
          const canvasTurns: CanvasTurn[] = (stash?.turns ?? []).map((t) => ({ turns: t, invert: false }));
          if (turns) canvasTurns.push({ turns, invert: false });
          if (uploadRanges || canvasTurns.length) {
            if (renderer.getStrokeGeneration() === snapshot.strokeGeneration) {
              const uploadStart = performance.now();
              const whole = data;
              const gather: PackedGather = whole
                ? (r) => gatherPixelRanges(whole, r)
                : async (r) => {
                    const values = await historyManager.currentRanges(r);
                    if (!values) throw new Error("the block store cannot serve the committed pixels");
                    return values;
                  };
              try {
                if (canvasTurns.length) {
                  await applyCanvasTurns(renderer, gather, canvasTurns, uploadRanges ?? undefined);
                  if (!openFiles[activeFileId]) return;
                }
                if (uploadRanges) {
                  if (renderer.getStrokeGeneration() === snapshot.strokeGeneration) {
                    if (whole) renderer.patchFBOData(whole, uploadRanges);
                    else renderer.patchFBODataCompact(await gather(uploadRanges), uploadRanges);
                  } else {
                    setCanvasPatchStash(activeFileId, { ranges: uploadRanges, turns: [] });
                    renderer.forgetBlocks(
                      historyDirtyRanges ? mergePixelRanges(uploadRanges, historyDirtyRanges) : uploadRanges,
                    );
                  }
                }
                diag.timing("timing", "commit FBO upload", performance.now() - uploadStart);
              } catch (error) {
                // The canvas kept pixels the store could not serve; the next
                // navigation rebuilds it whole.
                console.error("the commit patch could not reach the canvas:", error);
                historyManager.markFboOutOfSync();
              }
            } else if (openFiles[activeFileId]) {
              // A new stroke started while this one was in flight; its dabs
              // are not in the patch, so uploading would paint over them.
              // Stash the patch for the next commit, or the next navigation,
              // to upload with its own.
              setCanvasPatchStash(activeFileId, {
                ranges: uploadRanges ?? new Uint32Array(0),
                turns: canvasTurns.map((t) => t.turns),
              });
              // The canvas's cached blocks over the stroke are older than the
              // store now, so they are read again rather than composed.
              const stale = uploadRanges ?? new Uint32Array(0);
              renderer.forgetBlocks(historyDirtyRanges ? mergePixelRanges(stale, historyDirtyRanges) : stale);
            }
          }

          const updated = openFiles[activeFileId];
          // A stroke that changed nothing gets no node, and the id that comes
          // back is its parent's — whose caches already belong to it.
          if (node.isNew && outcome.audioHop) historyManager.setNodeAudioHop(node.id, outcome.audioHop);
          if (node.isNew && outcome.audioBuffer) {
            historyManager.setStateAudio(node.id, outcome.audioBuffer, result.peak > 0 ? result.peak : 1);
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
      try {
        await commitTask;
      } finally {
        releasePaint?.();
      }
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
      // Snapping follows the brush's first step, not the selected one, so
      // selecting a step never moves where the arrow keys land.
      const step = state.brushes[state.activeBrushIndex]?.steps?.[0] as Record<string, unknown> | undefined;
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
      const renderer = file.rendererRef.current;
      if (!renderer.beginStroke()) return;
      renderer.renderStroke(false);
      const result = await renderer.settleStroke();
      if (result.status !== "completed" || get().activeFileId !== activeFileId) {
        if (result.status === "completed") await renderer.discardStrokePreview();
        renderer.endStroke();
        return;
      }
      const commit = applyStrokeAtPosition();
      renderer.endStroke();
      await commit;
    },
  };
};
