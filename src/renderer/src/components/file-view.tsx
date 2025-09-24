import {
  activeFileAtom,
  activeFilePathAtom,
  bandsPerOctaveAtom,
  brushWidthAtom,
  filesBpmAtom,
  gridSizeAtom,
  gridSizeYAtom,
  mousePosAtom,
  openFilesAtom,
  rendererRefs,
  scrollAtom,
  sourceFilePathAtom,
  store,
  zoomPowerAtom,
} from "@/store";
import { ActionIcon, Box, Button, Flex, NumberInput, Title } from "@mantine/core";
import { View } from "@react-three/drei";
import { closeFile } from "@renderer/api";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import { memo, MouseEventHandler, useEffect, useRef } from "react";
import { Vector2 } from "three";
import { screenToZoomed } from "./brushes/common";
import { FileRenderer, FileRendererHandle } from "./file-renderer";
import { PlaybackLine } from "./playback-line";

interface FileViewProps {
  filePath: string;
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

export const FileView = memo(({ filePath }: FileViewProps) => {
  const files = useAtomValue(openFilesAtom);
  const file = files[filePath];
  const activeFile = useAtomValue(activeFileAtom);
  const setMousePos = useSetAtom(mousePosAtom);
  const setActiveFilePath = useSetAtom(activeFilePathAtom);
  const [bpms, setBpms] = useAtom(filesBpmAtom);
  const [sourceFilePath, setSourceFilePath] = useAtom(sourceFilePathAtom);
  const isSource = sourceFilePath === filePath;
  const bpm = bpms[filePath] || 120;
  const setBpm = (newBpm: number) => {
    setBpms((currentBpms) => ({
      ...currentBpms,
      [file.filePath]: newBpm,
    }));
  };

  const rendererRef = useRef<FileRendererHandle>(null);

  // Use an effect to manage adding/removing the ref from the global map
  useEffect(() => {
    // Add the ref to the map when the component mounts
    rendererRefs[filePath] = rendererRef;

    // Return a cleanup function to remove it when the component unmounts
    return () => {
      delete rendererRefs[filePath];
    };
  }, [filePath]); // This effect runs once per file path

  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    if (activeFile?.filePath !== file.filePath) return;
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
    if (activeFile?.filePath !== file.filePath) return;
    setMousePos(null);
    rendererRef.current?.clearPreview();
  };

  const handleCanvasMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (activeFile?.filePath !== file.filePath) return;
    if (event.button === 0 && rendererRef?.current) {
      const coords = getSnappedCoordinates(event, bpm);
      if (coords) {
        rendererRef.current!.renderStroke(coords[0], coords[1], false);
      }
    }
  };

  const handleCanvasMouseUp: MouseEventHandler<HTMLDivElement> = (event) => {
    if (activeFile?.filePath !== file.filePath) return;
    if (event.button === 0 && rendererRef?.current) {
      // Left mouse button up
      const data = rendererRef.current.getFBOData();
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
          <Button
            size="xs"
            variant="filled"
            onClick={(e) => {
              e.stopPropagation();
              setSourceFilePath(isSource ? null : file.filePath);
            }}
            color={isSource ? "orange" : "gray"}
          >
            Source
          </Button>
          <ActionIcon
            variant="transparent"
            color="white"
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
        h={400}
        style={{ cursor: activeFile?.filePath === file.filePath ? "none" : "auto" }}
        pos="relative"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleCanvasMouseDown}
        onMouseUp={handleCanvasMouseUp}
      >
        <View style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}>
          <FileRenderer file={file} ref={rendererRef} />
        </View>
      </Box>

      {activeFile?.filePath === file.filePath && <PlaybackLine file={file} />}
    </Box>
  );
});

FileView.displayName = "FileView";
