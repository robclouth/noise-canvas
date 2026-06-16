import { useStore } from "@/store";
import { useTransientStore } from "@renderer/store/transient";
import { Box, Loader, Text } from "@mantine/core";
import { View } from "@react-three/drei";
import { openFiles } from "@renderer/store/files";
import { useGesture } from "@use-gesture/react";
import { memo, PointerEventHandler, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Vector2 } from "three";
import { aimUvToBrushBlUv } from "../lib/brush-anchor";
import { BRUSH_ANCHOR_MODE_CENTER } from "../lib/constants";
import { penState } from "../lib/pen-state";
import { buildScaleOffsets, minFreqSemisAboveC0, snapSemisToScale } from "../lib/scale-snap";
import { screenToZoomed, snapToSwungGridCenter, snapToSwungGridFloor } from "../lib/utils";
import FileHeader from "./file-header";
import { FileRenderer, FileRendererHandle } from "./file-renderer";
import { LoopRegion } from "./loop-region";
import { PITCH_LEGEND_WIDTH, PitchLegend } from "./pitch-legend";
import { PlaybackLine } from "./playback-line";
import { TimeLegend } from "./time-legend";

export interface FileViewProps {
  fileId: string;
  isFullscreen?: boolean;
}

const viewStyle = { width: "100%", height: "100%", zIndex: 1 };

// Converts a mouse event into the aim point in the file's UV space, with
// optional grid/pitch snapping applied. Center-anchor mode snaps the aim to
// cell midpoints; corner-anchor mode snaps it to cell starts.
function getSnappedCoordinates(
  event: React.MouseEvent<HTMLDivElement>,
  fileId: string,
  bpm: number,
): [number, number] | null {
  const state = useStore.getState();
  const { gridSizeBeats, gridSizeSemis, gridSwing, snapTime, snapPitch, scaleTonic, scaleType } = state;
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;

  const screenUv = new Vector2(x, y);

  const zoom = new Vector2(state.filesZoom[fileId], state.filesZoomY[fileId] ?? 0);
  const offset = new Vector2(state.filesOffset[fileId], state.filesOffsetY[fileId] ?? 0);
  const uv = screenToZoomed(screenUv, zoom, offset);
  const spectrogramData = openFiles[fileId]?.spectrogramData;
  if (!spectrogramData) return null;

  // Center-anchor mode snaps the aim to the nearest cell midpoint so the
  // brush's visual center lands as close as possible to the cursor. With snap
  // off, the aim is used directly and the brush sits exactly on the cursor.
  const activeStep = state.brushes[state.activeBrushIndex]?.steps?.[state.activeStepIndex] as
    | Record<string, unknown>
    | undefined;
  const anchorMode = (activeStep?.brushAnchorMode as number | undefined) ?? state.brushAnchorMode;
  const isCenter = anchorMode === BRUSH_ANCHOR_MODE_CENTER;

  let snappedX = uv.x;
  let snappedY = uv.y;

  if (snapTime) {
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const gridIntervalSeconds = (60 / bpm) * gridSizeBeats;
    const currentTime = uv.x * totalDuration;
    const snapFn = isCenter ? snapToSwungGridCenter : snapToSwungGridFloor;
    const snappedTime = snapFn(currentTime, gridIntervalSeconds, gridSwing / 100);
    snappedX = snappedTime / totalDuration;
  }

  if (snapPitch) {
    snappedY = snapPitchUv(
      uv.y,
      spectrogramData.numBands,
      spectrogramData.bandsPerOctave,
      spectrogramData.minFreq,
      gridSizeSemis,
      scaleTonic,
      scaleType,
      isCenter,
    );
  }

  return [snappedX, snappedY];
}

// Resolves the aim point to the brush's bottom-left UV for the active file,
// using the shared brush-anchor helper.
function aimToBrushBlUv(aimUv: { x: number; y: number }, fileId: string, bpm: number): [number, number] {
  const spectrogramData = openFiles[fileId]?.spectrogramData;
  if (!spectrogramData) return [aimUv.x, aimUv.y];
  const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
  const { blX, blY } = aimUvToBrushBlUv(
    useStore.getState(),
    aimUv.x,
    aimUv.y,
    bpm,
    totalDuration,
    spectrogramData.bandsPerOctave,
    spectrogramData.numBands,
  );
  return [blX, blY];
}

// Snaps a pitch-axis UV to the scale (when gridSizeSemis is 0 / "Scale" mode)
// or to the chromatic gridSizeSemis cell. In chromatic mode, centerSnap
// returns the cell midpoint; otherwise the cell start. Scale mode always
// returns the nearest scale note (scale notes are points, not cells).
function snapPitchUv(
  uvY: number,
  numBands: number,
  bandsPerOctave: number,
  minFreq: number,
  gridSizeSemis: number,
  scaleTonic: string,
  scaleType: string,
  centerSnap: boolean,
): number {
  const bandsPerSemitone = bandsPerOctave / 12;
  if (gridSizeSemis <= 0) {
    const currentBand = (1.0 - uvY) * numBands;
    const semisAboveMin = currentBand / bandsPerSemitone;
    const pitchOffset = minFreqSemisAboveC0(minFreq);
    const absSemis = pitchOffset + semisAboveMin;
    const offsets = buildScaleOffsets(scaleTonic, scaleType);
    const snappedAbs = snapSemisToScale(absSemis, offsets);
    const snappedBand = (snappedAbs - pitchOffset) * bandsPerSemitone;
    return 1.0 - snappedBand / numBands;
  }
  const gridIntervalBands = gridSizeSemis * bandsPerSemitone;
  const currentBand = (1.0 - uvY) * numBands;
  const snappedBand = centerSnap
    ? (Math.round(currentBand / gridIntervalBands - 0.5) + 0.5) * gridIntervalBands
    : Math.floor(currentBand / gridIntervalBands) * gridIntervalBands;
  return 1.0 - snappedBand / numBands;
}

export const FileView = memo(({ fileId, isFullscreen = false }: FileViewProps) => {
  const file = openFiles[fileId];
  const filePath = file?.filePath || "";
  console.log("FileView render", fileId, filePath);

  const activeFileId = useStore((state) => state.activeFileId);
  const isActive = activeFileId === fileId;
  const pickingFileParam = useStore((state) => state.pickingFileParam);
  const isZooming = useStore((state) => state.isZooming);
  const isSynthesizing = useStore((state) => state.filesSynthesizing[fileId]);
  const loadingMessage = useStore((state) => state.filesLoading[fileId]);

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
      state.setFileZoom(fileId, clamped);
      state.setFileOffset(fileId, newOffset);
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
      onWheel: ({ event, delta: [dx, dy], velocity: [vx, vy], direction: [dirX, dirY], last }) => {
        event.preventDefault();
        const rect = viewRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;

        const wheelEvent = event as WheelEvent;
        const isPinch = wheelEvent.ctrlKey;
        const isExplicitZoom = wheelEvent.metaKey || isZooming;

        if (isPinch || isExplicitZoom) {
          stopMomentum();
          const sensitivity = isPinch ? 0.02 : 0.01;
          const cursorU = (wheelEvent.clientX - rect.left) / rect.width;
          const oldPower = useStore.getState().filesZoom[fileId];
          applyCursorCentricXZoom(oldPower - dy * sensitivity, cursorU);
          return;
        }

        stopMomentum();
        applyScrollDelta(dx, dy);

        if (last) {
          const signedVx = vx * dirX;
          const signedVy = vy * dirY;
          if (Math.abs(signedVx) > 0.05 || Math.abs(signedVy) > 0.05) {
            startMomentum(signedVx, signedVy);
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

  const uvToBeatsAndPitch = useCallback(
    (uvX: number, uvY: number) => {
      const state = useStore.getState();
      const { filePath, spectrogramData } = openFiles[fileId];
      if (!spectrogramData) return { beats: 0, pitch: 0 };
      const bpm = state.filepathsBpm[filePath];
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const timeSeconds = uvX * totalDuration;
      const centerBeats = (timeSeconds / 60) * bpm;
      const beats = centerBeats;
      const bandIndex = (1 - uvY) * spectrogramData.numBands;
      const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
      const centerPitch = bandIndex / bandsPerSemitone;
      const pitch = centerPitch;
      return { beats, pitch };
    },
    [fileId],
  );

  const handleMouseMove: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (isPanning) return;
      penState.pressure = event.pointerType === "pen" ? event.pressure : 1;
      penState.tiltX = event.tiltX;
      penState.tiltY = event.tiltY;
      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;
      const [snappedX, snappedY] = coords;

      // Track the stroke's time range in brush-BL time so autoplay loops
      // cover the painted region for either anchor mode.
      if (isStrokingRef.current && strokeTimeRangeRef.current.min !== null) {
        const { spectrogramData } = file;
        if (!spectrogramData) return;
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const [blX] = aimToBrushBlUv({ x: snappedX, y: snappedY }, fileId, bpm);
        const currentBrushTime = blX * totalDuration;
        strokeTimeRangeRef.current.min = Math.min(strokeTimeRangeRef.current.min!, currentBrushTime);
        strokeTimeRangeRef.current.max = Math.max(strokeTimeRangeRef.current.max!, currentBrushTime);
      }

      // Only update if position actually changed
      if (
        !lastSnappedPositionRef.current ||
        lastSnappedPositionRef.current.x !== snappedX ||
        lastSnappedPositionRef.current.y !== snappedY
      ) {
        // Convert to beats/pitch and update cursor position
        const { beats, pitch } = uvToBeatsAndPitch(snappedX, snappedY);
        useTransientStore.getState().setCursorPosition({ beats, pitch });
        useTransientStore.getState().setCursorVisible(true);
        useTransientStore.getState().setHoveredFile(fileId);
        lastSnappedPositionRef.current = { x: snappedX, y: snappedY };

        // Only call renderStroke when actually dragging (applying stroke)
        // Preview is handled by the renderer watching cursorPosition
        if (rendererRef.current) {
          const isDragging = isStrokingRef.current;
          const [blX, blY] = aimToBrushBlUv({ x: snappedX, y: snappedY }, fileId, bpm);
          rendererRef.current.renderStroke(blX, blY, !isDragging);
        }
      }
    },
    [fileId, isActive, file, isPanning, uvToBeatsAndPitch],
  );

  const handleMouseEnter: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (isPanning) return;
      const state = useStore.getState();
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;
      const [snappedX, snappedY] = coords;

      const { beats, pitch } = uvToBeatsAndPitch(snappedX, snappedY);
      useTransientStore.getState().setCursorPosition({ beats, pitch });
      useTransientStore.getState().setCursorVisible(true);
      useTransientStore.getState().setHoveredFile(fileId);
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };

      if (rendererRef.current) {
        const [blX, blY] = aimToBrushBlUv({ x: snappedX, y: snappedY }, fileId, bpm);
        rendererRef.current.renderStroke(blX, blY, true);
      }
    },
    [fileId, isPanning, uvToBeatsAndPitch],
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
      const coords = getSnappedCoordinates(event, fileId, bpm);
      if (!coords) return;

      // Pick mode: clicking on a canvas sets the file path and position params
      if (state.pickingFileParam) {
        state.setParameter(state.pickingFileParam, { path: openFiles[fileId].filePath });
        // Set position params (UV 0-1 → 0-100%). Y is inverted between display and spectrogram space.
        state.setParameter("sourceTimeOffset" as import("@renderer/store/types").ParameterKey, coords[0] * 100);
        state.setParameter(
          "sourcePitchOffset" as import("@renderer/store/types").ParameterKey,
          (1.0 - coords[1]) * 100,
        );
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
        const { beats, pitch } = uvToBeatsAndPitch(coords[0], coords[1]);
        useTransientStore.getState().setCursorPosition({ beats, pitch });

        const [blX, blY] = aimToBrushBlUv({ x: coords[0], y: coords[1] }, fileId, bpm);

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
              const bScale = spectrogramData.numBands / sourceOpenFile.spectrogramData.numBands;

              const offsetX = -blX * tScale;
              const offsetY = -(1 - blY) * bScale;
              state.updateActiveStepLockedOffset({ beats: offsetX, pitch: offsetY });
            }
          }
        }

        rendererRef.current.renderStroke(blX, blY, false);
      }
    },
    [fileId, isActive, uvToBeatsAndPitch, file],
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
    const handleWindowMouseMove = (event: MouseEvent) => {
      if (!isStrokingRef.current) return;

      const rect = viewRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;

      // Calculate UV coordinates - these can go outside 0-1 range when cursor is outside canvas
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;

      const screenUv = new Vector2(x, y);
      const state = useStore.getState();
      const currentZoom = new Vector2(state.filesZoom[fileId], state.filesZoomY[fileId] ?? 0);
      const currentOffset = new Vector2(state.filesOffset[fileId], state.filesOffsetY[fileId] ?? 0);
      const uv = screenToZoomed(screenUv, currentZoom, currentOffset);

      // Apply snapping
      const { gridSizeBeats, gridSizeSemis, gridSwing, snapTime, snapPitch, scaleTonic, scaleType } = state;
      const spectrogramData = openFiles[fileId]?.spectrogramData;
      if (!spectrogramData) return;
      const bpm = state.filepathsBpm[openFiles[fileId].filePath];

      const activeStep = state.brushes[state.activeBrushIndex]?.steps?.[state.activeStepIndex] as
        | Record<string, unknown>
        | undefined;
      const anchorMode = (activeStep?.brushAnchorMode as number | undefined) ?? state.brushAnchorMode;
      const isCenter = anchorMode === BRUSH_ANCHOR_MODE_CENTER;

      let snappedX = uv.x;
      let snappedY = uv.y;

      if (snapTime) {
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const gridIntervalSeconds = (60 / bpm) * gridSizeBeats;
        const currentTime = uv.x * totalDuration;
        const snapFn = isCenter ? snapToSwungGridCenter : snapToSwungGridFloor;
        const snappedTime = snapFn(currentTime, gridIntervalSeconds, gridSwing / 100);
        snappedX = snappedTime / totalDuration;
      }

      if (snapPitch) {
        snappedY = snapPitchUv(
          uv.y,
          spectrogramData.numBands,
          spectrogramData.bandsPerOctave,
          spectrogramData.minFreq,
          gridSizeSemis,
          scaleTonic,
          scaleType,
          isCenter,
        );
      }

      const [blX, blY] = aimToBrushBlUv({ x: snappedX, y: snappedY }, fileId, bpm);

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
      const positionChanged =
        !lastPos || Math.abs(lastPos.x - snappedX) > 0.0001 || Math.abs(lastPos.y - snappedY) > 0.0001;

      // Update cursor position
      const { beats, pitch } = uvToBeatsAndPitch(snappedX, snappedY);
      useTransientStore.getState().setCursorPosition({ beats, pitch });
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };

      // Only render if position actually changed (prevents duplicate iterations at same grid cell)
      if (positionChanged && rendererRef.current) {
        rendererRef.current.renderStroke(blX, blY, false);
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

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [fileId, finishStroke, uvToBeatsAndPitch]);

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
              <View style={viewStyle}>
                <FileRenderer fileId={fileId} ref={refCallback} />
              </View>
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
