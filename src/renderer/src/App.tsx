import { Flex } from "@mantine/core";
import { useAtom } from "jotai";
import { useEffect, useRef } from "react";
import { Vector2 } from "three";
import { BrushType, brushes } from "@/components/brushes";
import { RendererHandle } from "@/components/renderer";
import { CanvasPanel } from "@/components/layout/canvas-panel";
import { ControlsPanel } from "@/components/layout/controls-panel";
import { BrushPanel } from "@/components/layout/brush-panel";
import { useIpcListeners } from "@/hooks/use-ipc-listeners";
import {
  bandsPerOctaveAtom,
  bpmAtom,
  brushTypeAtom,
  brushWidthAtom,
  gridSizeAtom,
  gridSizeYAtom,
  scrollAtom,
  snapXAtom,
  snapYAtom,
  spectrogramDataAtom,
  store,
  zoomPowerAtom,
} from "@/store";
import { screenToZoomed } from "@/components/brushes/common";

function App(): React.JSX.Element {
  const [brushType, setBrushType] = useAtom(brushTypeAtom);
  const rendererRef = useRef<RendererHandle>(null);
  const lastSnappedPositionRef = useRef<{ x: number; y: number } | null>(null);

  // Initialize IPC listeners
  useIpcListeners(rendererRef);

  // Ensure brushType is valid, reset if not
  useEffect(() => {
    if (!brushes[brushType]) {
      setBrushType(Object.keys(brushes)[0] as BrushType);
    }
  }, [brushType, setBrushType]);

  const getSnappedCoordinates = (event: React.MouseEvent<HTMLDivElement>): [number, number] | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    const zoomPower = store.get(zoomPowerAtom);
    const scroll = store.get(scrollAtom);
    const zoomedX = screenToZoomed(new Vector2(x, y), zoomPower, scroll).x;

    const spectrogramData = store.get(spectrogramDataAtom);
    if (!spectrogramData) {
      return [zoomedX, y];
    }

    let snappedX = zoomedX;
    let snappedY = y;

    const snapX = store.get(snapXAtom);
    const bpm = store.get(bpmAtom);
    const gridSize = store.get(gridSizeAtom);
    const brushWidth = store.get(brushWidthAtom);

    // Snap X to the nearest grid line
    if (snapX) {
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
    const gridSizeY = store.get(gridSizeYAtom);

    // Snap Y to the nearest MIDI note
    if (snapY) {
      const bandsPerOctave = store.get(bandsPerOctaveAtom);
      const bandsPerSemitone = bandsPerOctave / 12;
      const gridIntervalBands = gridSizeY * bandsPerSemitone;
      const currentBand = y * spectrogramData.numBands;
      const snappedBand = Math.round(currentBand / gridIntervalBands) * gridIntervalBands;
      snappedY = snappedBand / spectrogramData.numBands;
    }

    return [snappedX, snappedY];
  };

  const performBrushStroke = (snappedX: number, snappedY: number, force = false): void => {
    if (!rendererRef.current) return;
    if (
      force ||
      !lastSnappedPositionRef.current ||
      lastSnappedPositionRef.current.x !== snappedX ||
      lastSnappedPositionRef.current.y !== snappedY
    ) {
      rendererRef.current.update(snappedX, snappedY);
      lastSnappedPositionRef.current = { x: snappedX, y: snappedY };
    }
  };

  return (
    <Flex h="100vh" w="100vw" bg="dark.8" c="gray.2">
      <ControlsPanel />
      <CanvasPanel
        rendererRef={rendererRef}
        getSnappedCoordinates={getSnappedCoordinates}
        performBrushStroke={performBrushStroke}
      />
      <BrushPanel />
    </Flex>
  );
}

export default App;
