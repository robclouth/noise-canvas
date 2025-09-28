import { openFiles, useStore } from "@/store";
import { ActionIcon, Box, Button, Group, NumberInput, Title } from "@mantine/core";
import { View } from "@react-three/drei";
import { X } from "lucide-react";
import { memo, MouseEventHandler, useCallback, useRef } from "react";
import { Vector2 } from "three";
import { FileRenderer, FileRendererHandle } from "./file-renderer";
import { PlaybackLine } from "./playback-line";

export interface FileViewProps {
  filePath: string;
}

function getSnappedCoordinates(
  event: React.MouseEvent<HTMLDivElement>,
  filePath: string,
  bpm: number,
): [number, number] | null {
  const { gridSizeBeats, brushWidthBeats, gridSizeSemis, brushHeightSemis, bandsPerOctave } = useStore.getState();
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;

  const uv = new Vector2(x, y);

  const { spectrogramData } = openFiles[filePath];

  let snappedX = uv.x;
  let snappedY = uv.y;

  if (gridSizeBeats.value > 0) {
    if (brushWidthBeats.value > 0) {
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const gridIntervalSeconds = (60 / bpm) * gridSizeBeats.value;
      const currentTime = uv.x * totalDuration;

      const brushWidthSeconds = brushWidthBeats.value * (60.0 / bpm);
      const startTime = currentTime - brushWidthSeconds / 2.0;

      const snappedStartTime = Math.round(startTime / gridIntervalSeconds) * gridIntervalSeconds;
      const snappedCenterTime = snappedStartTime + brushWidthSeconds / 2.0;

      snappedX = snappedCenterTime / totalDuration;
    } else {
      snappedX = 0.5;
    }
  }

  if (gridSizeSemis.value > 0) {
    if (brushHeightSemis.value > 0) {
      const bandsPerSemitone = bandsPerOctave.value / 12;
      const gridIntervalBands = gridSizeSemis.value * bandsPerSemitone;
      const currentBand = uv.y * spectrogramData.numBands;
      const snappedBand = Math.round(currentBand / gridIntervalBands) * gridIntervalBands;
      snappedY = snappedBand / spectrogramData.numBands;
    } else {
      snappedY = 0.5;
    }
  }

  return [snappedX, snappedY];
}

const Header = memo(function Header({ filePath }: FileViewProps) {
  const setSourceFilePath = useStore((state) => state.setSourceFilePath);
  const bpm = useStore((state) => state.filesBpm[filePath] ?? 120);
  const setFileBpm = useStore((state) => state.setFileBpm);
  const closeFile = useStore((state) => state.closeFile);
  const sourceFilePath = useStore((state) => state.sourceFilePath);

  const isSource = sourceFilePath === filePath;

  return (
    <Group justify="space-between" align="center" p="xs" wrap="nowrap">
      <Title order={6}>{filePath.split("/").pop() || filePath}</Title>
      <Group align="center" gap="xs" wrap="nowrap">
        <NumberInput
          w={60}
          value={bpm}
          onChange={(val) => setFileBpm(filePath, Number(val))}
          size="xs"
          max={999}
          min={10}
        />
        <Button
          size="xs"
          variant="filled"
          onClick={(e) => {
            e.stopPropagation();
            setSourceFilePath(isSource ? null : filePath);
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
            closeFile(filePath);
          }}
        >
          <X />
        </ActionIcon>
      </Group>
    </Group>
  );
});

export const FileView = memo(({ filePath }: FileViewProps) => {
  const activeFilePath = useStore((state) => state.activeFilePath);

  const setActiveFilePath = useStore((state) => state.setActiveFilePath);
  const setMousePos = useStore((state) => state.setMousePos);

  const isActive = activeFilePath === filePath;

  const rendererRef = useRef<FileRendererHandle>(null);

  const refCallback = useCallback(
    (handle: FileRendererHandle | null) => {
      rendererRef.current = handle;
      const file = openFiles[filePath];
      if (handle && file) {
        file.rendererRef = rendererRef;
      }
    },
    [filePath],
  );

  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    if (!isActive) return;
    const bpm = useStore.getState().filesBpm[filePath] ?? 120;
    const coords = getSnappedCoordinates(event, filePath, bpm);
    if (!coords) return;
    const [snappedX, snappedY] = coords;

    if (
      rendererRef.current &&
      (!lastSnappedPositionRef.current ||
        lastSnappedPositionRef.current.x !== snappedX ||
        lastSnappedPositionRef.current.y !== snappedY)
    ) {
      setMousePos(new Vector2(snappedX, 1 - snappedY));
      rendererRef.current.renderStroke(snappedX, snappedY, event.buttons !== 1);
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };
    }
  };

  const handleMouseLeave = () => {
    if (!isActive) return;
    setMousePos(null);
    rendererRef.current?.clearPreview();
  };

  const handleCanvasMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (!isActive) return;
    if (event.button === 0 && rendererRef?.current) {
      const bpm = useStore.getState().filesBpm[filePath] ?? 120;
      const coords = getSnappedCoordinates(event, filePath, bpm);
      if (coords) {
        rendererRef.current!.renderStroke(coords[0], coords[1], false);
      }
    }
  };

  const handleCanvasMouseUp: MouseEventHandler<HTMLDivElement> = (event) => {
    if (!isActive) return;
    if (event.button === 0 && rendererRef?.current) {
      // Left mouse button up
      const data = rendererRef.current.getFBOData();
      if (data) {
        window.api.addUndoState({
          data: data.buffer,
          filePath,
        });
      }
    }
  };

  return (
    <Box
      onClick={() => {
        setActiveFilePath(filePath);
      }}
      pos="relative"
      bd={isActive ? "2px solid orange" : "2px solid transparent"}
    >
      <Header filePath={filePath} />
      <Box
        h={400}
        style={{ cursor: isActive ? "none" : "auto" }}
        pos="relative"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleCanvasMouseDown}
        onMouseUp={handleCanvasMouseUp}
      >
        <View style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}>
          <FileRenderer filePath={filePath} ref={refCallback} />
        </View>
      </Box>

      {isActive && <PlaybackLine filePath={filePath} />}
    </Box>
  );
});

FileView.displayName = "FileView";
