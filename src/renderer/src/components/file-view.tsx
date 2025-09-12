import {
  activeFileAtom,
  activeFilePathAtom,
  bandsPerOctaveAtom,
  bpmAtom,
  brushHeightAtom,
  brushWidthAtom,
  closeFile,
  gridSizeAtom,
  gridSizeYAtom,
  mouseUvAtom,
  offsetXAtom,
  offsetYAtom,
  OpenFile,
  scrollAtom,
  store,
  zoomPowerAtom,
} from "@/store";
import { ActionIcon, Box, Flex, Title } from "@mantine/core";
import { useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import { CSSProperties, MouseEventHandler, RefObject, useRef, useState } from "react";
import { Vector2 } from "three";
import { screenToZoomed, unitsToUv, zoomedToScreen } from "./brushes/common";
import { FileRendererHandle } from "./file-renderer";
import { PlaybackLine } from "./playback-line";

interface FileViewProps {
  file: OpenFile;
  viewRef: RefObject<HTMLDivElement | null>;
  rendererRef: RefObject<FileRendererHandle | null>;
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

  const bpm = store.get(bpmAtom);
  const gridSize = store.get(gridSizeAtom);
  const brushWidth = store.get(brushWidthAtom);

  if (gridSize > 0) {
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const gridIntervalSeconds = (60 / bpm) * gridSize;
    const currentTime = zoomedUv.x * totalDuration;

    const brushWidthSeconds = brushWidth * (60.0 / bpm);
    const startTime = currentTime - brushWidthSeconds / 2.0;

    const snappedStartTime = Math.round(startTime / gridIntervalSeconds) * gridIntervalSeconds;
    const snappedCenterTime = snappedStartTime + brushWidthSeconds / 2.0;

    snappedX = snappedCenterTime / totalDuration;
  }

  const gridSizeY = store.get(gridSizeYAtom);

  if (gridSizeY > 0) {
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
  const activeFile = useAtomValue(activeFileAtom);
  const setMouseUv = useSetAtom(mouseUvAtom);
  const setActiveFilePath = useSetAtom(activeFilePathAtom);
  const [sourceRectStyle, setSourceRectStyle] = useState<CSSProperties>({ display: "none" });

  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    const coords = getSnappedCoordinates(event);
    if (!coords) return;
    const [snappedX, snappedY] = coords;

    setMouseUv(new Vector2(snappedX, 1 - snappedY));

    if (
      rendererRef.current &&
      (!lastSnappedPositionRef.current ||
        lastSnappedPositionRef.current.x !== snappedX ||
        lastSnappedPositionRef.current.y !== snappedY)
    ) {
      rendererRef.current.renderStroke(snappedX, snappedY, event.buttons !== 1);
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };
    }

    const { spectrogramData } = store.get(activeFileAtom)!;
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const bpm = store.get(bpmAtom);
    const brushWidth = store.get(brushWidthAtom);
    const brushHeight = store.get(brushHeightAtom);
    const bandsPerOctave = store.get(bandsPerOctaveAtom);

    const brushSizeUv = unitsToUv(
      brushWidth,
      brushHeight,
      bpm,
      totalDuration,
      bandsPerOctave,
      spectrogramData.numBands,
    );

    const offsetX = store.get(offsetXAtom);
    const offsetY = store.get(offsetYAtom);
    const offsetUv = unitsToUv(offsetX, offsetY, bpm, totalDuration, bandsPerOctave, spectrogramData.numBands);

    const zoomPower = store.get(zoomPowerAtom);
    const scroll = store.get(scrollAtom);

    const sourceCenterUv = new Vector2(snappedX, snappedY).add(offsetUv);
    const topLeftUv = new Vector2(sourceCenterUv.x - brushSizeUv.x / 2, sourceCenterUv.y - brushSizeUv.y / 2);
    const bottomRightUv = new Vector2(sourceCenterUv.x + brushSizeUv.x / 2, sourceCenterUv.y + brushSizeUv.y / 2);

    const topLeftScreen = zoomedToScreen(topLeftUv, zoomPower, scroll);
    const bottomRightScreen = zoomedToScreen(bottomRightUv, zoomPower, scroll);

    setSourceRectStyle({
      display: "block",
      position: "absolute",
      border: "1px solid white",
      left: `${topLeftScreen.x * 100}%`,
      top: `${topLeftScreen.y * 100}%`,
      width: `${(bottomRightScreen.x - topLeftScreen.x) * 100}%`,
      height: `${(bottomRightScreen.y - topLeftScreen.y) * 100}%`,
      pointerEvents: "none",
      zIndex: 1,
    });
  };

  const handleMouseLeave = () => {
    setMouseUv(null);
    setSourceRectStyle({ display: "none" });
  };

  const handleCanvasMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button === 0 && file.rendererRef?.current) {
      // Left mouse button down
      const beforeState = file.rendererRef.current.getFBOData();
      if (beforeState) {
        // We'll capture the 'after' state on mouse up
        (event.currentTarget as any)._undoBeforeState = beforeState;
      }

      const coords = getSnappedCoordinates(event);
      if (coords) {
        rendererRef.current!.renderStroke(coords[0], coords[1], false);
      }
    }
  };

  const handleCanvasMouseUp: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button === 0 && file.rendererRef?.current) {
      // Left mouse button up
      const beforeState = (event.currentTarget as any)._undoBeforeState;
      if (beforeState) {
        const afterState = file.rendererRef.current.getFBOData();
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
      onClick={() => {
        setActiveFilePath(file.filePath);
      }}
      pos="relative"
      bd={activeFile?.filePath === file.filePath ? "2px solid orange" : "2px solid transparent"}
    >
      <Flex justify="space-between" align="center" p="xs">
        <Title order={6}>{file.filePath.split("/").pop() || file.filePath}</Title>
        <ActionIcon
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            closeFile(file);
          }}
        >
          <X />
        </ActionIcon>
      </Flex>
      <Box pos="relative">
        <Box
          ref={viewRef}
          h={400}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onMouseDown={handleCanvasMouseDown}
          onMouseUp={handleCanvasMouseUp}
        />
        <div style={sourceRectStyle} />
      </Box>
      {activeFile?.filePath === file.filePath && <PlaybackLine file={file} containerRef={viewRef} />}
    </Box>
  );
};
