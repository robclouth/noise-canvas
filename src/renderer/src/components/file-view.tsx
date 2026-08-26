import { useStore } from "@/store";
import { useTransientStore } from "@renderer/store/transient";
import { Box, Loader, Text } from "@mantine/core";
import { View } from "@react-three/drei";
import { openFiles, viewSyncTargets } from "@renderer/store/files";
import { useGesture } from "@use-gesture/react";
import { memo, PointerEventHandler, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AimUv } from "../lib/aim";
import { aimUvToBrushBlUv, brushUnionForAim } from "../lib/brush-anchor";
import { heldRepeatIntervalMs } from "../lib/brush-repeat";
import { penState } from "../lib/pen-state";
import { normaliseSelection, type SelectionCorner } from "../lib/selection";
import { sourceBandUvSlope, uvToUnits } from "../lib/utils";
import { getSelectionCorner, getSnappedCoordinates } from "../lib/view-aim";
import FileHeader from "./file-header";
import { FileRenderer, FileRendererHandle } from "./file-renderer";
import { LoopRegion } from "./loop-region";
import { SelectionRegion } from "./selection-region";
import { LevelStrip } from "./level-strip";
import { OnsetLegend } from "./onset-legend";
import { laneAnchorProps } from "../lib/ui-anchors";
import { PITCH_LEGEND_WIDTH, PitchLegend } from "./pitch-legend";
import { PlaybackLine } from "./playback-line";
import { TimeLegend } from "./time-legend";

export interface FileViewProps {
  fileId: string;
  isFullscreen?: boolean;
}

const viewStyle = { width: "100%", height: "100%", zIndex: 1 };

/**
 * How the spectrogram region is presented.
 * - "live": the WebGL view renders; no snapshot overlay.
 * - "static": a DOM canvas snapshot covers the region and the WebGL view is
 *   skipped, so the content scrolls natively with the page instead of being
 *   re-rendered on the shared canvas every frame.
 * - "unveiling": going static→live; the snapshot stays up until the WebGL
 *   view has drawn a frame underneath, so there's no background flash.
 */
type ViewPhase = "live" | "unveiling" | "static";

// Resolves the aim point to one step's brush bottom-left UV for the active
// file, using the shared brush-anchor helper.
function aimToBrushBlUv(aim: AimUv, fileId: string, bpm: number, stepIndex: number): { blX: number; blY: number } {
  const spectrogramData = openFiles[fileId]?.spectrogramData;
  if (!spectrogramData) return { blX: aim.x, blY: aim.y };
  const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
  return aimUvToBrushBlUv(
    useStore.getState(),
    aim.x,
    aim.y,
    bpm,
    totalDuration,
    spectrogramData.bandsPerOctave,
    spectrogramData.numBands,
    stepIndex,
  );
}

// Where the earliest step of the brush starts painting, in seconds. The stroke
// covers every step, so the region it reports starts at the earliest of them.
function aimToStrokeStartSeconds(aim: AimUv, fileId: string, bpm: number): number {
  const spectrogramData = openFiles[fileId]?.spectrogramData;
  if (!spectrogramData) return aim.x;
  const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
  const union = brushUnionForAim(
    useStore.getState(),
    aim.x,
    aim.y,
    bpm,
    totalDuration,
    spectrogramData.bandsPerOctave,
    spectrogramData.numBands,
  );
  return union.blX * totalDuration;
}

export const FileView = memo(({ fileId, isFullscreen = false }: FileViewProps) => {
  const file = openFiles[fileId];
  const filePath = file?.filePath || "";

  const activeFileId = useStore((state) => state.activeFileId);
  const isActive = activeFileId === fileId;
  const pickingFileParam = useStore((state) => state.pickingFileParam);
  const isZooming = useStore((state) => state.isZooming);
  const isSynthesizing = useStore((state) => state.filesSynthesizing[fileId]);
  const loadingMessage = useStore((state) => state.filesLoading[fileId]);
  const busyMessage = useStore((state) => state.filesBusy[fileId]);

  const isHovered = useTransientStore((state) => state.hoveredFile === fileId);
  // An axis drag moves every view-synced file, so all of them stay live.
  const axisDragFile = useTransientStore((state) => state.axisDragFile);
  const isAxisDragging = useStore((state) =>
    axisDragFile === null ? false : viewSyncTargets(state, axisDragFile).includes(fileId),
  );
  const cursorVisible = useTransientStore((state) => state.cursorVisible);
  const isStroking = useStore((state) => state.isStroking);
  // Every step names its own source file, so any of them keeps this lane live.
  const isExplicitSource = useStore((state) => {
    const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
    return steps.some((step) => step.sourceFile?.path === filePath);
  });

  const [isPanning, setIsPanning] = useState(false);
  const editMode = useStore((state) => state.editMode);

  const cursorStyle = useMemo(() => {
    if (isPanning) return { cursor: "grabbing" };
    if (isZooming) return { cursor: "zoom-in" };
    if (pickingFileParam) return { cursor: "crosshair" };
    return { cursor: "crosshair" };
  }, [pickingFileParam, isPanning, isZooming]);

  const rendererRef = useRef<FileRendererHandle>(null);
  const strokeTimeRangeRef = useRef<{ min: number | null; max: number | null }>({ min: null, max: null });
  const viewRef = useRef<HTMLDivElement>(null);
  const isStrokingRef = useRef(false);
  // The corner a selection drag started from, or null when none is running.
  const selectionStartRef = useRef<SelectionCorner | null>(null);
  const momentumRef = useRef<{ vx: number; vy: number; raf: number | null }>({ vx: 0, vy: 0, raf: null });
  // Non-null while the held brush repeats on its own clock; the move handlers
  // then leave the painting to the clock instead of dabbing per movement.
  const repeatIntervalRef = useRef<number | null>(null);
  const repeatClockRef = useRef<number | null>(null);
  const snapshotCanvasRef = useRef<HTMLCanvasElement>(null);

  // A view is live only while it can show cursor-dependent UI: hovered (brush
  // preview), active with a cursor anywhere (stroking + implicit-source
  // rectangle), a step's explicit source file (sampling rectangle), fullscreen,
  // or an axis-legend drag zooming/panning the view. Everything else is
  // presented as a static snapshot.
  const wantsLive =
    isHovered || isFullscreen || isAxisDragging || (isActive && (cursorVisible || isStroking)) || isExplicitSource;

  const [phase, setPhase] = useState<ViewPhase>("live");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const wantsLiveRef = useRef(wantsLive);
  wantsLiveRef.current = wantsLive;
  const captureInFlightRef = useRef(false);

  const trySnapshot = useCallback(() => {
    if (captureInFlightRef.current) return;
    const capture = rendererRef.current?.captureSnapshot();
    if (!capture) return;
    captureInFlightRef.current = true;
    capture
      .then((ok) => {
        if (ok && !wantsLiveRef.current) setPhase("static");
      })
      .finally(() => {
        captureInFlightRef.current = false;
      });
  }, []);

  useEffect(() => {
    if (!wantsLive && phase === "live") {
      trySnapshot();
    } else if (wantsLive && phase === "static") {
      setPhase("unveiling");
    }
  }, [wantsLive, phase, trySnapshot]);

  // Runs after each fully drawn live frame: completes the static→live unveil
  // (the WebGL view now has correct pixels under the snapshot) and retries
  // captures that raced renderer initialization.
  const handleLiveFrame = useCallback(() => {
    if (phaseRef.current === "unveiling") {
      setPhase("live");
    } else if (phaseRef.current === "live" && !wantsLiveRef.current) {
      trySnapshot();
    }
  }, [trySnapshot]);

  // A static snapshot is a fixed-size bitmap; when the view box resizes it
  // stretches, so re-capture at the new size.
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => {
      rendererRef.current?.refreshSnapshot();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadingMessage]);

  const stopMomentum = useCallback(() => {
    if (momentumRef.current.raf !== null) {
      cancelAnimationFrame(momentumRef.current.raf);
      momentumRef.current.raf = null;
    }
    momentumRef.current.vx = 0;
    momentumRef.current.vy = 0;
  }, []);

  const applyScrollDelta = useCallback(
    (dxPx: number, dyPx: number) => {
      const rect = viewRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const state = useStore.getState();
      const zx = state.filesZoom[fileId];
      const ox = state.filesOffset[fileId];
      const zy = state.filesZoomY[fileId] ?? 0;
      const oy = state.filesOffsetY[fileId] ?? 0;
      const zxPow = Math.pow(2, zx);
      const zyPow = Math.pow(2, zy);

      if (zxPow > 1 + 1e-9) {
        const viewWidth = 1 / zxPow;
        const ds = dxPx / rect.width;
        const denom = 1 - viewWidth;
        const shifted = ox + (ds * viewWidth) / (denom || 1);
        state.setFileOffset(fileId, Math.max(0, Math.min(1, shifted)));
      }
      if (zyPow > 1 + 1e-9) {
        const viewHeight = 1 / zyPow;
        const ds = dyPx / rect.height;
        const denom = 1 - viewHeight;
        const shifted = oy + (ds * viewHeight) / (denom || 1);
        state.setFileOffsetY(fileId, Math.max(0, Math.min(1, shifted)));
      }
    },
    [fileId],
  );

  const startMomentum = useCallback(
    (vxPxPerMs: number, vyPxPerMs: number) => {
      stopMomentum();
      const DECAY_PER_FRAME = 0.92;
      const MIN_VEL = 0.005;
      if (Math.abs(vxPxPerMs) < MIN_VEL && Math.abs(vyPxPerMs) < MIN_VEL) return;
      momentumRef.current.vx = vxPxPerMs;
      momentumRef.current.vy = vyPxPerMs;

      let last = performance.now();
      const step = (now: number) => {
        const dt = now - last;
        last = now;
        applyScrollDelta(momentumRef.current.vx * dt, momentumRef.current.vy * dt);
        const decay = Math.pow(DECAY_PER_FRAME, dt / 16.67);
        momentumRef.current.vx *= decay;
        momentumRef.current.vy *= decay;
        if (Math.abs(momentumRef.current.vx) < MIN_VEL && Math.abs(momentumRef.current.vy) < MIN_VEL) {
          momentumRef.current.raf = null;
          return;
        }
        momentumRef.current.raf = requestAnimationFrame(step);
      };
      momentumRef.current.raf = requestAnimationFrame(step);
    },
    [applyScrollDelta, stopMomentum],
  );

  const applyCursorCentricXZoom = useCallback(
    (newPower: number, cursorScreenU: number) => {
      const state = useStore.getState();
      const oldPower = state.filesZoom[fileId];
      const oldOffset = state.filesOffset[fileId];
      const clamped = Math.max(0, Math.min(newPower, 7));
      const oldZ = Math.pow(2, oldPower);
      const newZ = Math.pow(2, clamped);
      const oldViewWidth = 1 / oldZ;
      const newViewWidth = 1 / newZ;
      const oldViewStart = oldZ > 1 ? oldOffset * (1 - oldViewWidth) : 0;
      const u = oldViewStart + cursorScreenU * oldViewWidth;
      const newViewStart = u - cursorScreenU * newViewWidth;

      let newOffset: number;
      if (newZ <= 1 + 1e-9) {
        newOffset = 0;
      } else {
        const denom = 1 - newViewWidth;
        newOffset = denom > 0 ? newViewStart / denom : 0;
        newOffset = Math.max(0, Math.min(1, newOffset));
      }
      state.setFileZoomAndOffset(fileId, clamped, newOffset);
    },
    [fileId],
  );

  useEffect(() => () => stopMomentum(), [stopMomentum]);

  useGesture(
    {
      onDrag: ({ event, dragging, delta: [dx, dy], velocity: [vx, vy], direction: [dirX, dirY], last }) => {
        event.preventDefault();
        stopMomentum();
        setIsPanning(dragging ?? false);

        applyScrollDelta(-dx, -dy);

        if (last) {
          const signedVx = vx * dirX;
          const signedVy = vy * dirY;
          if (Math.abs(signedVx) > 0.05 || Math.abs(signedVy) > 0.05) {
            startMomentum(-signedVx, -signedVy);
          }
        }
      },
      onWheel: ({ event, delta: [dx, dy], velocity: [vx], direction: [dirX], last }) => {
        const wheelEvent = event as WheelEvent;
        const isPinch = wheelEvent.ctrlKey;
        const isExplicitZoom = wheelEvent.metaKey || isZooming;

        const rect = viewRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;

        if (isPinch || isExplicitZoom) {
          event.preventDefault();
          stopMomentum();
          const sensitivity = isPinch ? 0.02 : 0.01;
          const cursorU = (wheelEvent.clientX - rect.left) / rect.width;
          const oldPower = useStore.getState().filesZoom[fileId];
          applyCursorCentricXZoom(oldPower - dy * sensitivity, cursorU);
          return;
        }

        // Horizontal two-finger scroll pans the view; a vertical scroll bubbles
        // up to the parent container so the file views scroll vertically.
        if (Math.abs(dx) <= Math.abs(dy)) return;

        event.preventDefault();
        stopMomentum();
        applyScrollDelta(dx, 0);

        if (last) {
          const signedVx = vx * dirX;
          if (Math.abs(signedVx) > 0.05) {
            startMomentum(signedVx, 0);
          }
        }
      },
    },
    {
      target: viewRef,
      eventOptions: { passive: false },
      drag: {
        pointer: { buttons: [2], mouse: true },
        from: () => [0, 0],
        filterTaps: true,
      },
    },
  );

  const refCallback = useCallback(
    (handle: FileRendererHandle | null) => {
      rendererRef.current = handle;
      const file = openFiles[fileId];
      if (handle && file) {
        file.rendererRef = rendererRef;
      }
    },
    [fileId],
  );

  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  const aimToBeatsAndPitch = useCallback(
    (aim: AimUv) => {
      const state = useStore.getState();
      const { filePath, spectrogramData } = openFiles[fileId];
      if (!spectrogramData) return { beats: 0, pitch: 0 };
      const bpm = state.filepathsBpm[filePath];
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const [beats, pitch] = uvToUnits(
        aim.x,
        aim.y,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );
      return { beats, pitch };
    },
    [fileId],
  );

  const handleMouseMove: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      // A control drag is aimed at the control, wherever the pointer travels.
      if (isPanning || useTransientStore.getState().controlDragging) return;
      const store = useStore.getState();
      if (store.placing) {
        // The ghost follows the pointer across views: entering another file's
        // canvas carries it over, keeping its frequencies.
        if (store.placing.fileId !== fileId) store.retargetPlacing(fileId);
        const placing = useStore.getState().placing;
        if (placing?.fileId !== fileId) return;
        const corner = getSelectionCorner(
          event.clientX,
          event.clientY,
          event.currentTarget.getBoundingClientRect(),
          fileId,
          store.filepathsBpm[openFiles[fileId].filePath],
        );
        const spectrogram = openFiles[fileId]?.spectrogramData;
        if (!corner || !spectrogram) return;
        const duration = spectrogram.numFrames / spectrogram.sampleRate;
        // Shift holds the region at the pitch it was picked up from, so a move
        // along the file cannot drift off its own frequencies.
        const pitch = event.shiftKey ? placing.rect.pitchLo : corner.pitchUv;
        store.movePlacing(corner.timeUv * duration, pitch);
        return;
      }
      if (store.editMode === "select") return;
      penState.pressure = event.pointerType === "pen" ? event.pressure : 1;
      penState.tiltX = event.tiltX;
      penState.tiltY = event.tiltY;
      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];
      const aim = getSnappedCoordinates(
        event.clientX,
        event.clientY,
        event.currentTarget.getBoundingClientRect(),
        fileId,
        bpm,
      );
      if (!aim) return;

      // Track the stroke's time range in brush-BL time so autoplay loops
      // cover the painted region for either anchor mode.
      if (isStrokingRef.current && strokeTimeRangeRef.current.min !== null) {
        const { spectrogramData } = file;
        if (!spectrogramData) return;
        const currentBrushTime = aimToStrokeStartSeconds(aim, fileId, bpm);
        strokeTimeRangeRef.current.min = Math.min(strokeTimeRangeRef.current.min!, currentBrushTime);
        strokeTimeRangeRef.current.max = Math.max(strokeTimeRangeRef.current.max!, currentBrushTime);
      }

      // Only update if position actually changed
      if (
        !lastSnappedPositionRef.current ||
        lastSnappedPositionRef.current.x !== aim.x ||
        lastSnappedPositionRef.current.y !== aim.y
      ) {
        // Convert to beats/pitch and update cursor position
        const { beats, pitch } = aimToBeatsAndPitch(aim);
        useTransientStore.getState().setCursorPosition({ beats, pitch });
        useTransientStore.getState().setCursorVisible(true);
        useTransientStore.getState().setHoveredFile(fileId);
        lastSnappedPositionRef.current = { x: aim.x, y: aim.y };

        // Only call renderStroke when actually dragging (applying stroke)
        // Preview is handled by the renderer watching cursorPosition
        const repeating = isStrokingRef.current && repeatIntervalRef.current !== null;
        if (rendererRef.current && !repeating) {
          rendererRef.current.renderStroke(!isStrokingRef.current);
        }
      }
    },
    [fileId, isActive, file, isPanning, aimToBeatsAndPitch],
  );

  const handleMouseEnter: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (isPanning || useTransientStore.getState().controlDragging) return;
      if (useStore.getState().editMode === "select") {
        useTransientStore.getState().setHoveredFile(fileId);
        return;
      }
      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];
      const aim = getSnappedCoordinates(
        event.clientX,
        event.clientY,
        event.currentTarget.getBoundingClientRect(),
        fileId,
        bpm,
      );
      if (!aim) return;

      const { beats, pitch } = aimToBeatsAndPitch(aim);
      useTransientStore.getState().setCursorPosition({ beats, pitch });
      useTransientStore.getState().setCursorVisible(true);
      useTransientStore.getState().setHoveredFile(fileId);
      lastSnappedPositionRef.current = { x: aim.x, y: aim.y };

      rendererRef.current?.renderStroke(true);
    },
    [fileId, isPanning, aimToBeatsAndPitch],
  );

  const handleMouseLeave = useCallback(() => {
    // Don't clear state if we're in the middle of a stroke - we'll handle it via window events
    if (isStrokingRef.current) return;

    // Hide cursor when mouse leaves, but keep position so keyboard can resume from here
    useTransientStore.getState().setCursorVisible(false);
    useTransientStore.getState().setHoveredFile(null);
    rendererRef.current?.clearPreview();
    lastSnappedPositionRef.current = null;
  }, []);

  const stopRepeatClock = useCallback(() => {
    if (repeatClockRef.current !== null) cancelAnimationFrame(repeatClockRef.current);
    repeatClockRef.current = null;
    repeatIntervalRef.current = null;
  }, []);

  /**
   * Paints the held brush again at a fixed rate, so a stroke keeps building
   * while the pointer stays still. Does nothing when no step accumulates,
   * where a repeat would land on the same result.
   */
  const startRepeatClock = useCallback(() => {
    stopRepeatClock();
    const interval = heldRepeatIntervalMs(useStore.getState());
    if (interval === null) return;
    repeatIntervalRef.current = interval;

    let nextAt = performance.now() + interval;
    const tick = (now: number) => {
      if (!isStrokingRef.current) {
        repeatClockRef.current = null;
        return;
      }
      if (now >= nextAt) {
        rendererRef.current?.renderStroke(false);
        // A repeat missed by a slow frame is dropped, not repaid as a burst.
        nextAt = Math.max(now, nextAt + interval);
      }
      repeatClockRef.current = requestAnimationFrame(tick);
    };
    repeatClockRef.current = requestAnimationFrame(tick);
  }, [stopRepeatClock]);

  useEffect(() => stopRepeatClock, [stopRepeatClock]);

  // Select mode has no brush under the pointer, so the hover preview goes away
  // with the mode rather than waiting for the pointer to leave the lane.
  useEffect(() => {
    if (editMode !== "select") return;
    useTransientStore.getState().setCursorVisible(false);
    rendererRef.current?.clearPreview();
  }, [editMode]);

  const handleCanvasMouseDown: PointerEventHandler<HTMLDivElement> = useCallback(
    async (event) => {
      if (event.button !== 0) return;

      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];
      const aim = getSnappedCoordinates(
        event.clientX,
        event.clientY,
        event.currentTarget.getBoundingClientRect(),
        fileId,
        bpm,
      );
      if (!aim) return;

      // A drop beats pick mode: while a region is in flight, the click puts it
      // down whatever else the canvas is armed for.
      if (state.placing) {
        if (state.placing.fileId !== fileId) state.retargetPlacing(fileId);
        if (useStore.getState().placing?.fileId === fileId) await state.dropPlacing();
        return;
      }

      // Pick mode: clicking on a canvas sets the file path and position params
      if (state.pickingFileParam) {
        state.setParameter(state.pickingFileParam, { path: openFiles[fileId].filePath });
        // Set position params (UV 0-1 → 0-100%).
        state.setParameter("sourceTimeOffset" as import("@renderer/store/types").ParameterKey, aim.x * 100);
        state.setParameter("sourcePitchOffset" as import("@renderer/store/types").ParameterKey, aim.y * 100);
        state.setPickingFileParam(null);
        return;
      }

      if (state.editMode === "select") {
        if (!isActive) state.setActiveFileId(fileId);
        const corner = getSelectionCorner(
          event.clientX,
          event.clientY,
          event.currentTarget.getBoundingClientRect(),
          fileId,
          bpm,
        );
        if (!corner) return;
        selectionStartRef.current = corner;
        useTransientStore.getState().setSelectionDrag(null);
        return;
      }

      if (!isActive) {
        state.setActiveFileId(fileId);
      }

      if (rendererRef?.current) {
        const { spectrogramData } = file;
        if (!spectrogramData) return;
        isStrokingRef.current = true;
        state.setIsStroking(true);
        rendererRef.current.beginStroke();
        const { beats, pitch } = aimToBeatsAndPitch(aim);
        useTransientStore.getState().setCursorPosition({ beats, pitch });

        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const strokeStartSeconds = aimToStrokeStartSeconds(aim, fileId, bpm);
        strokeTimeRangeRef.current = { min: strokeStartSeconds, max: strokeStartSeconds };

        // Lock the source offset of every anchored step. Tracking, Source and
        // the brush origin are all per-step, so each step measures its own
        // offset from its own origin against its own source file.
        const destBpm = state.filepathsBpm[file.filePath] || 120;
        state.lockStepSourceOffsets(
          state.getSteps().map((step, index) => {
            const sourceFileValue = step?.sourceFile ?? null;
            if (!sourceFileValue) return null;
            if ((step?.sourcePositionMode ?? "anchored") !== "anchored") return null;
            const sourceOpenFile = Object.values(openFiles).find((f) => f.filePath === sourceFileValue.path);
            if (!sourceOpenFile?.spectrogramData) return null;
            const srcBpm = state.filepathsBpm[sourceOpenFile.filePath] || 120;
            const srcDur = sourceOpenFile.spectrogramData.numFrames / sourceOpenFile.spectrogramData.sampleRate;
            const tScale = (destBpm * totalDuration) / (srcBpm * srcDur);
            const bScale = sourceBandUvSlope(spectrogramData, sourceOpenFile.spectrogramData);
            const { blX, blY } = aimToBrushBlUv(aim, fileId, bpm, index);
            return { beats: -blX * tScale, pitch: -blY * bScale };
          }),
        );

        rendererRef.current.renderStroke(false);
        startRepeatClock();
      }
    },
    [fileId, isActive, aimToBeatsAndPitch, file, startRepeatClock],
  );

  const handleCanvasMouseUp: PointerEventHandler<HTMLDivElement> = useCallback(
    async (event) => {
      if (!isActive) return;
      if (event.button === 0) {
        await finishStroke();
      }
    },
    [isActive],
  );

  // Helper to finish a stroke - used by both handleCanvasMouseUp and window mouseup
  const finishStroke = useCallback(async () => {
    if (!isStrokingRef.current) return;
    isStrokingRef.current = false;
    stopRepeatClock();

    const state = useStore.getState();
    state.setIsStroking(false);
    const finalRange = strokeTimeRangeRef.current;

    // Use unified action with time range
    if (finalRange.min !== null && finalRange.max !== null) {
      await state.applyStrokeAtPosition(undefined, { min: finalRange.min, max: finalRange.max });
    } else {
      await state.applyStrokeAtPosition();
    }
    rendererRef.current?.endStroke();

    strokeTimeRangeRef.current = { min: null, max: null };
  }, [stopRepeatClock]);

  // Window-level event listeners to handle mouse movements and releases outside the file view
  useEffect(() => {
    const endStrokeOutsideWindow = async () => {
      if (!isStrokingRef.current) return;
      await finishStroke();
      useTransientStore.getState().setCursorVisible(false);
      useTransientStore.getState().setHoveredFile(null);
      rendererRef.current?.clearPreview();
      lastSnappedPositionRef.current = null;
    };

    const updateSelectionDrag = (event: MouseEvent): void => {
      const from = selectionStartRef.current;
      const rect = viewRef.current?.getBoundingClientRect();
      const spectrogramData = openFiles[fileId]?.spectrogramData;
      if (!from || !rect || !spectrogramData) return;
      const bpm = useStore.getState().filepathsBpm[openFiles[fileId].filePath];
      const to = getSelectionCorner(event.clientX, event.clientY, rect, fileId, bpm);
      if (!to) return;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const selection = normaliseSelection(from, to, totalDuration);
      useTransientStore.getState().setSelectionDrag(selection ? { fileId, selection } : null);
    };

    const finishSelectionDrag = (): void => {
      const from = selectionStartRef.current;
      if (!from) return;
      selectionStartRef.current = null;
      const drag = useTransientStore.getState().selectionDrag;
      useTransientStore.getState().setSelectionDrag(null);
      const store = useStore.getState();
      if (drag?.fileId === fileId) {
        store.setFileSelection(fileId, drag.selection);
        return;
      }
      // A click with no drag clears the selection and puts the play start
      // marker where it landed, on the same snap the selection corner uses.
      store.setFileSelection(fileId, null);
      const spectrogramData = openFiles[fileId]?.spectrogramData;
      if (!spectrogramData) return;
      const duration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const time = Math.max(0, Math.min(duration, from.timeUv * duration));
      store.setFilePlaybackStartTime(fileId, time);
      if (store.activeFileId === fileId && store.isPlaying) store.setPlaybackTime(time);
    };

    const handleWindowMouseMove = (event: MouseEvent) => {
      if (selectionStartRef.current) {
        if (event.buttons === 0) {
          finishSelectionDrag();
          return;
        }
        updateSelectionDrag(event);
        return;
      }
      if (!isStrokingRef.current) return;
      // A release outside the window sends no mouseup here, so the first move
      // back inside is where the stroke learns the button is no longer held.
      if (event.buttons === 0) {
        void endStrokeOutsideWindow();
        return;
      }

      const rect = viewRef.current?.getBoundingClientRect();
      if (!rect) return;

      const spectrogramData = openFiles[fileId]?.spectrogramData;
      if (!spectrogramData) return;
      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];

      // The aim can run outside 0-1 while the cursor is outside the canvas.
      const aim = getSnappedCoordinates(event.clientX, event.clientY, rect, fileId, bpm);
      if (!aim) return;

      // Track time range using brush BL (stroke start), so autoplay duration
      // lines up with the painted region regardless of anchor mode.
      const currentBrushTime = aimToStrokeStartSeconds(aim, fileId, bpm);
      if (strokeTimeRangeRef.current.min !== null) {
        strokeTimeRangeRef.current.min = Math.min(strokeTimeRangeRef.current.min, currentBrushTime);
        strokeTimeRangeRef.current.max = Math.max(strokeTimeRangeRef.current.max!, currentBrushTime);
      }

      // Check if snapped position actually changed (for grid snapping)
      const lastPos = lastSnappedPositionRef.current;
      const positionChanged = !lastPos || Math.abs(lastPos.x - aim.x) > 0.0001 || Math.abs(lastPos.y - aim.y) > 0.0001;

      // Update cursor position
      const { beats, pitch } = aimToBeatsAndPitch(aim);
      useTransientStore.getState().setCursorPosition({ beats, pitch });
      lastSnappedPositionRef.current = { x: aim.x, y: aim.y };

      // Only render if position actually changed (prevents duplicate iterations at same grid cell)
      if (positionChanged && rendererRef.current && repeatIntervalRef.current === null) {
        rendererRef.current.renderStroke(false);
      }
    };

    const handleWindowMouseUp = async (event: MouseEvent) => {
      if (event.button === 0 && selectionStartRef.current) {
        finishSelectionDrag();
        return;
      }
      if (event.button === 0 && isStrokingRef.current) {
        await finishStroke();
        // Clean up cursor state since we're outside the element
        useTransientStore.getState().setCursorVisible(false);
        useTransientStore.getState().setHoveredFile(null);
        rendererRef.current?.clearPreview();
        lastSnappedPositionRef.current = null;
      }
    };

    const handleWindowBlur = () => {
      finishSelectionDrag();
      void endStrokeOutsideWindow();
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [fileId, finishStroke, aimToBeatsAndPitch]);

  if (!file) return null;

  return (
    <Box
      pos="relative"
      bd={isActive ? "2px solid orange" : "2px solid dark.7"}
      h={isFullscreen ? "100%" : undefined}
      style={isFullscreen ? { display: "flex", flexDirection: "column", minHeight: 0 } : undefined}
      onPointerDown={() => {
        if (!isActive) {
          useStore.getState().setActiveFileId(fileId);
        }
      }}
      {...laneAnchorProps(fileId)}
    >
      <FileHeader fileId={fileId} />
      {loadingMessage || !file.spectrogramData ? (
        <Box
          h={isFullscreen ? undefined : 400}
          style={{
            ...(isFullscreen ? { flex: 1 } : {}),
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
          pos="relative"
        >
          <Loader size="sm" />
          {loadingMessage && (
            <Text size="xs" c="dimmed">
              {loadingMessage}
            </Text>
          )}
        </Box>
      ) : (
        <>
          <Box style={{ paddingLeft: PITCH_LEGEND_WIDTH }}>
            <LevelStrip fileId={fileId} />
          </Box>
          <Box style={{ paddingLeft: PITCH_LEGEND_WIDTH }}>
            <OnsetLegend fileId={fileId} />
          </Box>
          <Box
            h={isFullscreen ? undefined : 400}
            style={{
              ...(isFullscreen ? { flex: 1 } : {}),
              display: "flex",
              flexDirection: "row",
            }}
          >
            <PitchLegend fileId={fileId} />
            <Box
              ref={viewRef}
              data-file-view-id={fileId}
              style={{ flex: 1, ...cursorStyle }}
              pos="relative"
              onPointerEnter={handleMouseEnter}
              onPointerMove={handleMouseMove}
              onPointerLeave={handleMouseLeave}
              onPointerDown={handleCanvasMouseDown}
              onPointerUp={handleCanvasMouseUp}
              onContextMenu={(e) => e.preventDefault()}
            >
              <View style={viewStyle} visible={phase !== "static"}>
                <FileRenderer
                  fileId={fileId}
                  ref={refCallback}
                  isLive={phase !== "static"}
                  snapshotCanvasRef={snapshotCanvasRef}
                  onLiveFrame={handleLiveFrame}
                />
              </View>
              <canvas
                ref={snapshotCanvasRef}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  zIndex: 2,
                  pointerEvents: "none",
                  visibility: phase === "live" ? "hidden" : "visible",
                }}
              />
              {isActive && <LoopRegion fileId={fileId} />}
              <SelectionRegion fileId={fileId} />
              {isActive && <PlaybackLine fileId={fileId} />}
            </Box>
          </Box>
          <Box style={{ paddingLeft: PITCH_LEGEND_WIDTH }}>
            <TimeLegend fileId={fileId} />
          </Box>
        </>
      )}
      {isSynthesizing && <Loader size="xs" pos="absolute" bottom={25} right={10} />}
      {/* The view stays visible under a splice; this layer just badges it and
          soaks up pointer input until the rebuild lands. */}
      {busyMessage && (
        <Box
          pos="absolute"
          style={{
            inset: 0,
            zIndex: 3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "wait",
          }}
        >
          <Box
            bg="dark.7"
            px={10}
            py={6}
            style={{
              borderRadius: 6,
              border: "1px solid var(--mantine-color-dark-4)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              {busyMessage}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
});

FileView.displayName = "FileView";
