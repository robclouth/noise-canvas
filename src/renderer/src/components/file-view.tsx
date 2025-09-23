import {
  activeFileAtom,
  activeFilePathAtom,
  bandsPerOctaveAtom,
  brushWidthAtom,
  closeFile,
  filesBpmAtom,
  gridSizeAtom,
  gridSizeYAtom,
  mousePosAtom,
  OpenFile,
  scrollAtom,
  store,
  zoomPowerAtom,
} from "@/store";
import { ActionIcon, Box, Flex, NumberInput, Title } from "@mantine/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import { memo, MouseEventHandler, RefObject, useRef } from "react";
import { Vector2 } from "three";
import { screenToZoomed } from "./brushes/common";
import { FileRendererHandle } from "./file-renderer";
import { PlaybackLine } from "./playback-line";

interface FileViewProps {
  file: OpenFile;
  viewRef: RefObject<HTMLDivElement | null>;
  rendererRef: RefObject<FileRendererHandle | null>;
}

function getSnappedCoordinates(event: React.MouseEvent<HTMLDivElement>, bpm: number): [number, number] | null {
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

export const FileView = memo(({ file, viewRef, rendererRef }: FileViewProps) => {
  const activeFile = useAtomValue(activeFileAtom);
  const setMousePos = useSetAtom(mousePosAtom);
  const setActiveFilePath = useSetAtom(activeFilePathAtom);
  const [bpms, setBpms] = useAtom(filesBpmAtom);
  const bpm = bpms[file.filePath] || 120;
  const setBpm = (newBpm: number) => {
    setBpms((currentBpms) => ({
      ...currentBpms,
      [file.filePath]: newBpm,
    }));
  };

  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    const coords = getSnappedCoordinates(event, bpm);
    if (!coords) return;
    const [snappedX, snappedY] = coords;

    setMousePos(new Vector2(snappedX, 1 - snappedY));

    if (
      rendererRef.current &&
      (!lastSnappedPositionRef.current ||
        lastSnappedPositionRef.current.x !== snappedX ||
        lastSnappedPositionRef.current.y !== snappedY)
    ) {
      rendererRef.current.renderStroke(snappedX, snappedY, event.buttons !== 1);
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };
    }
  };

  const handleMouseLeave = () => {
    setMousePos(null);
  };

  const handleCanvasMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button === 0 && file.rendererRef?.current) {
      const coords = getSnappedCoordinates(event, bpm);
      if (coords) {
        rendererRef.current!.renderStroke(coords[0], coords[1], false);
      }
    }
  };

  const handleCanvasMouseUp: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button === 0 && file.rendererRef?.current) {
      // Left mouse button up
      const data = file.rendererRef.current.getFBOData();
      if (data) {
        window.api.addUndoState({
          data: data.buffer,
          filePath: file.filePath,
        });
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
        <Flex align="center" gap="xs">
          <NumberInput w={60} value={bpm} onChange={(val) => setBpm(Number(val))} size="xs" max={999} min={10} />
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
      </Flex>
      <Box
        style={{ cursor: "none" }}
        ref={viewRef}
        h={400}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleCanvasMouseDown}
        onMouseUp={handleCanvasMouseUp}
      />

      {activeFile?.filePath === file.filePath && <PlaybackLine file={file} containerRef={viewRef} />}
    </Box>
  );
});

FileView.displayName = "FileView";
