import { Box } from "@mantine/core";
import { useAtomValue, useSetAtom } from "jotai";
import { MouseEventHandler, useEffect, useRef, useState, RefObject } from "react";
import * as THREE from "three";
import { createPortal } from "react-dom";
import { playbackTimeAtom } from "@/audio-manager";
import {
  OpenFile,
  activeFileAtom,
  bandsPerOctaveAtom,
  bpmAtom,
  brushWidthAtom,
  gridSizeAtom,
  gridSizeYAtom,
  isPlayingAtom,
  mouseUvAtom,
  scrollAtom,
  snapXAtom,
  snapYAtom,
  store,
  zoomPowerAtom,
} from "@/store";
import { screenToZoomed, zoomedToScreen } from "./brushes/common";
import { useSpectrogramManager } from "@/components/use-spectrogram-manager";
import { RenderingContext } from "@/rendering-context";

interface RendererProps {
  file: OpenFile;
  containerRef: RefObject<HTMLDivElement>;
  context: RenderingContext;
}

export const Renderer = ({ file, containerRef, context }: RendererProps) => {
  const setMouseUv = useSetAtom(mouseUvAtom);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const playbackLineRef = useRef<HTMLDivElement>(null);
  const isPlaying = useAtomValue(isPlayingAtom);
  const animationFrameIdRef = useRef<number | null>(null);
  const activeFile = useAtomValue(activeFileAtom);
  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  const manager = useSpectrogramManager(file, context);

  const getSnappedCoordinates = (event: React.MouseEvent<HTMLDivElement>): [number, number] | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    const zoomPower = store.get(zoomPowerAtom);
    const scroll = store.get(scrollAtom);
    const zoomedX = screenToZoomed(new THREE.Vector2(x, y), zoomPower, scroll).x;

    let snappedX = zoomedX;
    let snappedY = y;

    if (activeFile?.id !== file.id) return [snappedX, snappedY];

    const snapX = store.get(snapXAtom);
    if (snapX) {
      const { spectrogramData } = file;
      const bpm = store.get(bpmAtom);
      const gridSize = store.get(gridSizeAtom);
      const brushWidth = store.get(brushWidthAtom);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const gridIntervalSeconds = (60 / bpm) * gridSize;
      const currentTime = zoomedX * totalDuration;
      const brushWidthSeconds = brushWidth * (60.0 / bpm);
      const startTime = currentTime - brushWidthSeconds / 2.0;
      const snappedStartTime = Math.round(startTime / gridIntervalSeconds) * gridIntervalSeconds;
      const snappedCenterTime = snappedStartTime + brushWidthSeconds / 2.0;
      snappedX = snappedCenterTime / totalDuration;
    }

    const snapY = store.get(snapYAtom);
    if (snapY) {
      const { spectrogramData } = file;
      const gridSizeY = store.get(gridSizeYAtom);
      const bandsPerOctave = store.get(bandsPerOctaveAtom);
      const bandsPerSemitone = bandsPerOctave / 12;
      const gridIntervalBands = gridSizeY * bandsPerSemitone;
      const currentBand = y * spectrogramData.numBands;
      const snappedBand = Math.round(currentBand / gridIntervalBands) * gridIntervalBands;
      snappedY = snappedBand / spectrogramData.numBands;
    }

    return [snappedX, snappedY];
  };

  const performBrushStrokeWithDebounce = (snappedX: number, snappedY: number, force = false): void => {
    if (
      force ||
      !lastSnappedPositionRef.current ||
      lastSnappedPositionRef.current.x !== snappedX ||
      lastSnappedPositionRef.current.y !== snappedY
    ) {
      manager.performBrushStroke(snappedX, snappedY);
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };
    }
  };

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    const coords = getSnappedCoordinates(event);
    if (!coords) return;
    const [snappedX, snappedY] = coords;

    const mouseUv = new THREE.Vector2(snappedX, 1 - snappedY);
    setMouseUv(mouseUv);
    if (activeFile?.id === file.id) {
      manager.handleMouseUvUpdate(mouseUv);
    }

    if (event.buttons === 1 && activeFile?.id === file.id) {
      performBrushStrokeWithDebounce(snappedX, snappedY);
    }
  };

  const handleMouseLeave = () => {
    setMouseUv(null);
    if (activeFile?.id === file.id) {
      manager.handleMouseUvUpdate(null);
    }
  };

  const handleCanvasMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button === 0 && activeFile?.id === file.id && context) {
      const beforeState = context.getFBOData();
      if (beforeState) {
        (event.currentTarget as any)._undoBeforeState = beforeState;
      }
      const coords = getSnappedCoordinates(event);
      if (coords) {
        performBrushStrokeWithDebounce(coords[0], coords[1], true);
      }
    }
  };

  const handleCanvasMouseUp: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button === 0 && activeFile?.id === file.id && context) {
      const beforeState = (event.currentTarget as any)._undoBeforeState;
      if (beforeState) {
        const afterState = context.getFBOData();
        if (afterState) {
          window.api.addUndoState({ before: beforeState.buffer, after: afterState.buffer });
        }
        delete (event.currentTarget as any)._undoBeforeState;
      }
    }
  };

  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    if (containerRef.current) resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [containerRef]);

  useEffect(() => {
    const animate = () => {
      if (playbackLineRef.current && activeFile?.id === file.id) {
        const { spectrogramData } = file;
        const zoomPower = store.get(zoomPowerAtom);
        const scroll = store.get(scrollAtom);
        const playbackTime = store.get(playbackTimeAtom);

        if (canvasSize.width > 0) {
          const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
          const progress = playbackTime / totalDuration;
          const screenCoords = zoomedToScreen(new THREE.Vector2(progress, 0), zoomPower, scroll);
          const left = screenCoords.x * canvasSize.width;

          if (left < 0 || left > canvasSize.width) {
            playbackLineRef.current.style.display = "none";
          } else {
            playbackLineRef.current.style.display = "block";
            playbackLineRef.current.style.left = `${left}px`;
          }
        } else {
          playbackLineRef.current.style.display = "none";
        }
      } else if (playbackLineRef.current) {
        playbackLineRef.current.style.display = "none";
      }
      animationFrameIdRef.current = requestAnimationFrame(animate);
    };

    if (isPlaying) {
      animationFrameIdRef.current = requestAnimationFrame(animate);
    } else {
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
      if (playbackLineRef.current) playbackLineRef.current.style.display = "none";
    }

    return () => {
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
    };
  }, [isPlaying, canvasSize, file, activeFile]);

  if (!containerRef.current) {
    return null;
  }

  return createPortal(
    <Box
      pos="absolute"
      top={0}
      left={0}
      w="100%"
      h="100%"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleCanvasMouseDown}
      onMouseUp={handleCanvasMouseUp}
    >
      <div
        ref={playbackLineRef}
        style={{
          position: "absolute",
          top: 0,
          width: "1px",
          backgroundColor: "white",
          height: "100%",
          pointerEvents: "none",
          display: "none",
        }}
      />
    </Box>,
    containerRef.current,
  );
};
