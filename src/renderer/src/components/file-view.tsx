import {
  activeFileAtom,
  activeFileIdAtom,
  bandsPerOctaveAtom,
  bpmAtom,
  brushHeightAtom,
  brushIntensityAtom,
  brushTypeAtom,
  brushWidthAtom,
  closeFile,
  featherXAtom,
  featherYAtom,
  gridSizeAtom,
  gridSizeYAtom,
  mouseUvAtom,
  OpenFile,
  offsetXAtom,
  offsetYAtom,
  panAtom,
  scrollAtom,
  snapXAtom,
  snapYAtom,
  sourceFileAtom,
  store,
  zoomPowerAtom,
} from "@/store";
import { ActionIcon, Box, Flex, Title } from "@mantine/core";
import { useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import { MouseEventHandler, RefObject, useRef } from "react";
import { Vector2 } from "three";
import { screenToZoomed, unitsToUv } from "./brushes/common";
import { PlaybackLine } from "./playback-line";

interface FileViewProps {
  file: OpenFile;
  viewRef: RefObject<HTMLDivElement | null>;
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

  // Snap X to the nearest grid line
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

  // Snap Y to the nearest MIDI note
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

export const FileView = ({ file, viewRef }: FileViewProps) => {
  const setActiveFileId = useSetAtom(activeFileIdAtom);
  const activeFile = useAtomValue(activeFileAtom);
  const setMouseUv = useSetAtom(mouseUvAtom);

  const brushType = useAtomValue(brushTypeAtom);
  const brushWidth = useAtomValue(brushWidthAtom);
  const brushHeight = useAtomValue(brushHeightAtom);
  const brushIntensity = useAtomValue(brushIntensityAtom);
  const featherX = useAtomValue(featherXAtom);
  const featherY = useAtomValue(featherYAtom);
  const pan = useAtomValue(panAtom);
  const zoomPower = useAtomValue(zoomPowerAtom);
  const scroll = useAtomValue(scrollAtom);
  const bpm = useAtomValue(bpmAtom);
  const bandsPerOctave = useAtomValue(bandsPerOctaveAtom);
  const offsetX = useAtomValue(offsetXAtom);
  const offsetY = useAtomValue(offsetYAtom);
  const sourceFile = useAtomValue(sourceFileAtom);

  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  const performBrushStroke = (snappedX: number, snappedY: number, force = false): void => {
    if (!file.renderingContext || !file.spectrogramData) return;
    if (
      force ||
      !lastSnappedPositionRef.current ||
      lastSnappedPositionRef.current.x !== snappedX ||
      lastSnappedPositionRef.current.y !== snappedY
    ) {
      const { spectrogramData } = file;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      const brushSizeUv = unitsToUv(
        brushWidth,
        brushHeight,
        bpm,
        totalDuration,
        bandsPerOctave,
        spectrogramData.numBands,
      );
      const offsetUv = unitsToUv(offsetX, offsetY, bpm, totalDuration, bandsPerOctave, spectrogramData.numBands);

      const crossFileTexture = sourceFile?.renderingContext?.getFBO()?.texture ?? null;
      file.renderingContext.renderStroke({
        brushType,
        brushCenterUv: new Vector2(snappedX, 1 - snappedY),
        brushSizeUv,
        brushIntensity,
        featherX: featherX / 100,
        featherY: featherY / 100,
        pan,
        offsetUv,
        zoomPower,
        scroll,
        crossFileTexture,
      });
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
    if (event.button === 0 && file.renderingContext) {
      // Left mouse button down
      const beforeState = file.renderingContext.getFBOData();
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
    if (event.button === 0 && file.renderingContext) {
      // Left mouse button up
      const beforeState = (event.currentTarget as any)._undoBeforeState;
      if (beforeState) {
        const afterState = file.renderingContext.getFBOData();
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
