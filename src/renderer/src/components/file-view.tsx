import { useStore } from "@/store";
import { useTransientStore } from "@renderer/store/transient";
import { Box, Loader, Text } from "@mantine/core";
import { View } from "@react-three/drei";
import { openFiles, viewSyncTargets } from "@renderer/store/files";
import { useGesture } from "@use-gesture/react";
import { memo, PointerEventHandler, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Vector2 } from "three";
import { resolveAimUv, type AimUv } from "../lib/aim";
import { aimUvToBrushBlUv } from "../lib/brush-anchor";
import { getFileOnsets } from "../lib/file-onsets";
import { penState } from "../lib/pen-state";
import { sourceBandUvSlope, uvToUnits } from "../lib/utils";
import FileHeader from "./file-header";
import { FileRenderer, FileRendererHandle } from "./file-renderer";
import { LoopRegion } from "./loop-region";
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

// Resolves a pointer position to the aim point in pitch UV, reading the grid,
// scale and anchor settings off the store. Center-anchor mode snaps the aim to
// cell midpoints; corner-anchor mode snaps it to cell starts.
function getSnappedCoordinates(clientX: number, clientY: number, rect: DOMRect, fileId: string, bpm: number) {
  if (rect.width === 0 || rect.height === 0) return null;
  const spectrogramData = openFiles[fileId]?.spectrogramData;
  if (!spectrogramData) return null;

  const state = useStore.getState();
  const activeStep = state.brushes[state.activeBrushIndex]?.steps?.[state.activeStepIndex] as
    | Record<string, unknown>
    | undefined;

  return resolveAimUv({
    viewUv: new Vector2((clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height),
    zoom: new Vector2(state.filesZoom[fileId], state.filesZoomY[fileId] ?? 0),
    offset: new Vector2(state.filesOffset[fileId], state.filesOffsetY[fileId] ?? 0),
    bpm,
    spectrogram: {
      numBands: spectrogramData.numBands,
      bandsPerOctave: spectrogramData.bandsPerOctave,
      minFreq: spectrogramData.minFreq,
      totalDuration: spectrogramData.numFrames / spectrogramData.sampleRate,
    },
    snapping: {
      snapTime: state.snapTime,
      snapPitch: state.snapPitch,
      gridSizeBeats: state.gridSizeBeats,
      gridSizeSemis: state.gridSizeSemis,
      gridSwing: state.gridSwing,
      scaleTonic: state.scaleTonic,
      scaleType: state.scaleType,
      anchorMode: (activeStep?.brushAnchorMode as number | undefined) ?? state.brushAnchorMode,
    },
    onsets: getFileOnsets(fileId),
  });
}

// Resolves the aim point to the brush's bottom-left UV for the active file,
// using the shared brush-anchor helper.
function aimToBrushBlUv(aim: AimUv, fileId: string, bpm: number): { blX: number; blY: number } {
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
  );
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

  const isHovered = useTransientStore((state) => state.hoveredFile === fileId);
  // An axis drag moves every view-synced file, so all of them stay live.
  const axisDragFile = useTransientStore((state) => state.axisDragFile);
  const isAxisDragging = useStore((state) =>
    axisDragFile === null ? false : viewSyncTargets(state, axisDragFile).includes(fileId),
  );
  const cursorVisible = useTransientStore((state) => state.cursorVisible);
  const isStroking = useStore((state) => state.isStroking);
  const explicitSourcePath = useStore((state) => {
    const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
    return steps[state.activeStepIndex]?.sourceFile?.path ?? null;
  });

  const [isPanning, setIsPanning] = useState(false);

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
  const momentumRef = useRef<{ vx: number; vy: number; raf: number | null }>({ vx: 0, vy: 0, raf: null });
  const snapshotCanvasRef = useRef<HTMLCanvasElement>(null);

  // A view is live only while it can show cursor-dependent UI: hovered (brush
  // preview), active with a cursor anywhere (stroking + implicit-source
  // rectangle), the active step's explicit source file (sampling rectangle),
  // fullscreen, or an axis-legend drag zooming/panning the view. Everything
  // else is presented as a static snapshot.
  const wantsLive =
    isHovered ||
    isFullscreen ||
    isAxisDragging ||
    (isActive && (cursorVisible || isStroking)) ||
    (explicitSourcePath !== null && explicitSourcePath === filePath);

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
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const { blX } = aimToBrushBlUv(aim, fileId, bpm);
        const currentBrushTime = blX * totalDuration;
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
        if (rendererRef.current) {
          rendererRef.current.renderStroke(!isStrokingRef.current);
        }
      }
    },
    [fileId, isActive, file, isPanning, aimToBeatsAndPitch],
  );

  const handleMouseEnter: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (isPanning || useTransientStore.getState().controlDragging) return;
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

      // Pick mode: clicking on a canvas sets the file path and position params
      if (state.pickingFileParam) {
        state.setParameter(state.pickingFileParam, { path: openFiles[fileId].filePath });
        // Set position params (UV 0-1 → 0-100%).
        state.setParameter("sourceTimeOffset" as import("@renderer/store/types").ParameterKey, aim.x * 100);
        state.setParameter("sourcePitchOffset" as import("@renderer/store/types").ParameterKey, aim.y * 100);
        state.setPickingFileParam(null);
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

        const { blX, blY } = aimToBrushBlUv(aim, fileId, bpm);

        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const strokeStartSeconds = blX * totalDuration;
        strokeTimeRangeRef.current = { min: strokeStartSeconds, max: strokeStartSeconds };

        // Compute the locked offset for anchored source mode using the brush
        // BL (the shader's stroke origin) so source sampling stays anchored to
        // the onset corner in both anchor modes.
        const { getActiveStep } = state;
        const activeStep = getActiveStep();
        const sourceFileValue = activeStep?.sourceFile ?? null;
        if (sourceFileValue) {
          const sourcePositionMode = activeStep?.sourcePositionMode ?? "anchored";
          if (sourcePositionMode === "anchored") {
            const sourceOpenFile = Object.values(openFiles).find((f) => f.filePath === sourceFileValue.path);
            if (sourceOpenFile?.spectrogramData && spectrogramData) {
              const destBpm = state.filepathsBpm[file.filePath] || 120;
              const destDur = spectrogramData.numFrames / spectrogramData.sampleRate;
              const srcBpm = state.filepathsBpm[sourceOpenFile.filePath] || 120;
              const srcDur = sourceOpenFile.spectrogramData.numFrames / sourceOpenFile.spectrogramData.sampleRate;
              const tScale = (destBpm * destDur) / (srcBpm * srcDur);
              const bScale = sourceBandUvSlope(spectrogramData, sourceOpenFile.spectrogramData);

              const offsetX = -blX * tScale;
              const offsetY = -blY * bScale;
              state.updateActiveStepLockedOffset({ beats: offsetX, pitch: offsetY });
            }
          }
        }

        rendererRef.current.renderStroke(false);
      }
    },
    [fileId, isActive, aimToBeatsAndPitch, file],
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
  }, []);

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

    const handleWindowMouseMove = (event: MouseEvent) => {
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

      const { blX } = aimToBrushBlUv(aim, fileId, bpm);

      // Track time range using brush BL (stroke start), so autoplay duration
      // lines up with the painted region regardless of anchor mode.
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const currentBrushTime = blX * totalDuration;
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
      if (positionChanged && rendererRef.current) {
        rendererRef.current.renderStroke(false);
      }
    };

    const handleWindowMouseUp = async (event: MouseEvent) => {
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
      style={isFullscreen ? { display: "flex", flexDirection: "column" } : undefined}
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
              {isActive && <PlaybackLine fileId={fileId} />}
            </Box>
          </Box>
          <Box style={{ paddingLeft: PITCH_LEGEND_WIDTH }}>
            <TimeLegend fileId={fileId} />
          </Box>
        </>
      )}
      {isSynthesizing && <Loader size="xs" pos="absolute" bottom={25} right={10} />}
    </Box>
  );
});

FileView.displayName = "FileView";
