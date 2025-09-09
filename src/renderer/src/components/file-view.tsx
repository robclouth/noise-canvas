import {
  activeFileAtom,
  activeFileIdAtom,
  bandsPerOctaveAtom,
  bpmAtom,
  brushWidthAtom,
  closeFile,
  gridSizeAtom,
  gridSizeYAtom,
  mouseUvAtom,
  OpenFile,
  scrollAtom,
  snapXAtom,
  snapYAtom,
  store,
  zoomPowerAtom,
} from "@/store";
import { ActionIcon, Box, Flex, Title } from "@mantine/core";
import { useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import { ForwardedRef, MouseEventHandler, RefObject, useRef } from "react";
import { Vector2 } from "three";
import { screenToZoomed } from "./brushes/common";
import { FileRendererHandle } from "./file-renderer";
import { PlaybackLine } from "./playback-line";

interface FileViewProps {
  file: OpenFile;
  viewRef: RefObject<HTMLDivElement | null>;
  rendererRef: ForwardedRef<FileRendererHandle | null>;
}

function getSnappedCoordinates(event: React.MouseEvent<HTMLDivElement>): [number, number] | null {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;

  const zoomPower = store.get(zoomPowerAtom);
  const scroll = store.get(scrollAtom);
  const zoomedUv = screenToZoomed(new Vector2(x, y), zoomPower, scroll);

  const { spectrogramData } = store.get(activeFileAtom) ?? {};
  if (!spectrogramData) {
    return [zoomedUv.x, zoomedUv.y];
  }

  let snappedX = zoomedUv.x;
  let snappedY = zoomedUv.y;

  const snapX = store.get(snapXAtom);
  const bpm = store.get(bpmAtom);
  const gridSize = store.get(gridSizeAtom);
  const brushWidth = store.get(brushWidthAtom);

  if (snapX) {
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const gridIntervalSeconds = (60 / bpm) * gridSize;
    const currentTime = zoomedUv.x * totalDuration;

    const brushWidthSeconds = brushWidth * (60.0 / bpm);
    const startTime = currentTime - brushWidthSeconds / 2.0;

    const snappedStartTime = Math.round(startTime / gridIntervalSeconds) * gridIntervalSeconds;
    const snappedCenterTime = snappedStartTime + brushWidthSeconds / 2.0;

    snappedX = snappedCenterTime / totalDuration;
  }

  const snapY = store.get(snapYAtom);
  const gridSizeY = store.get(gridSizeYAtom);

  if (snapY) {
    const bandsPerOctave = store.get(bandsPerOctaveAtom);
    const bandsPerSemitone = bandsPerOctave / 12;
    const gridIntervalBands = gridSizeY * bandsPerSemitone;
    const currentBand = zoomedUv.y * spectrogramData.numBands;
    const snappedBand = Math.round(currentBand / gridIntervalBands) * gridIntervalBands;
    snappedY = snappedBand / spectrogramData.numBands;
  }

  return [snappedX, snappedY];
}

export const FileView = ({ file, viewRef, rendererRef }: FileViewProps) => {
  const setActiveFileId = useSetAtom(activeFileIdAtom);
  const activeFile = useAtomValue(activeFileAtom);
  const setMouseUv = useSetAtom(mouseUvAtom);

  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  const performBrushStroke = (snappedX: number, snappedY: number, force = false): void => {
    if (typeof rendererRef === "function" || !rendererRef?.current) return;

    if (
      force ||
      !lastSnappedPositionRef.current ||
      lastSnappedPositionRef.current.x !== snappedX ||
      lastSnappedPositionRef.current.y !== snappedY
    ) {
      rendererRef.current.renderStroke(snappedX, snappedY);
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };
    }
  };

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    const coords = getSnappedCoordinates(event);
    if (!coords) return;
    const [snappedX, snappedY] = coords;

    setMouseUv(new Vector2(snappedX, 1 - snappedY));

    if (event.buttons === 1) {
      performBrushStroke(snappedX, snappedY);
    }
  };

  const handleMouseLeave = () => {
    setMouseUv(null);
  };

  const handleCanvasMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button === 0 && file.renderer?.current) {
      // Left mouse button down
      const beforeState = file.renderer.current.getFBOData();
      if (beforeState) {
        // We'll capture the 'after' state on mouse up
        (event.currentTarget as any)._undoBeforeState = beforeState;
      }

      const coords = getSnappedCoordinates(event);
      if (coords) {
        performBrushStroke(coords[0], coords[1], true);
      }
    }
  };

  const handleCanvasMouseUp: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button === 0 && file.renderer?.current) {
      // Left mouse button up
      const beforeState = (event.currentTarget as any)._undoBeforeState;
      if (beforeState) {
        const afterState = file.renderer.current.getFBOData();
        if (afterState) {
          window.api.addUndoState({
            before: beforeState.buffer,
            after: afterState.buffer,
          });
        }
        delete (event.currentTarget as any)._undoBeforeState;
      }
    }
  };

  return (
    <Box
      onClick={() => setActiveFileId(file.id)}
      pos="relative"
      bd={activeFile?.id === file.id ? "2px solid orange" : "2px solid transparent"}
    >
      <Flex justify="space-between" align="center" p="xs">
        <Title order={6}>{file.filePath.split("/").pop() || file.filePath}</Title>
        <ActionIcon
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            closeFile(file.id);
          }}
        >
          <X />
        </ActionIcon>
      </Flex>
      <Box
        ref={viewRef}
        h={400}
        pos="relative"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleCanvasMouseDown}
        onMouseUp={handleCanvasMouseUp}
      />
      <PlaybackLine file={file} containerRef={viewRef} />
    </Box>
  );
};
