import { Box, Paper, Flex, NumberInput, ActionIcon, Text } from "@mantine/core";
import { Canvas } from "@react-three/fiber";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Play, Repeat, Square } from "lucide-react";
import { MouseEventHandler, RefObject, useEffect, useRef, useState } from "react";
import { Vector2 } from "three";
import { playAudio, playbackTimeAtom, stopAudio } from "../../audio-manager";
import {
  bpmAtom,
  isPlayingAtom,
  loopAtom,
  mouseUvAtom,
  scrollAtom,
  spectrogramDataAtom,
  store,
  zoomPowerAtom,
} from "../../store";
import { zoomedToScreen } from "../brushes/common";
import { Renderer, RendererHandle } from "../renderer";

type CanvasPanelProps = {
  rendererRef: RefObject<RendererHandle | null>;
  getSnappedCoordinates: (event: React.MouseEvent<HTMLDivElement>) => [number, number] | null;
  performBrushStroke: (snappedX: number, snappedY: number, force?: boolean) => void;
};

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  const ms = Math.floor((seconds % 1) * 1000)
    .toString()
    .padStart(3, "0");
  return `${h}:${m}:${s}:${ms}`;
};

export const CanvasPanel = ({ rendererRef, getSnappedCoordinates, performBrushStroke }: CanvasPanelProps) => {
  const setMouseUv = useSetAtom(mouseUvAtom);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const playbackLineRef = useRef<HTMLDivElement>(null);
  const playbackTime = useAtomValue(playbackTimeAtom);
  const [isPlaying, setIsPlaying] = useAtom(isPlayingAtom);
  const [bpm, setBpm] = useAtom(bpmAtom);
  const [loop, setLoop] = useAtom(loopAtom);
  const animationFrameIdRef = useRef<number | null>(null);

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
    if (event.button === 0 && rendererRef.current) {
      // Left mouse button down
      const beforeState = rendererRef.current.getFBOData();
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
    if (event.button === 0 && rendererRef.current) {
      // Left mouse button up
      const beforeState = (event.currentTarget as any)._undoBeforeState;
      if (beforeState) {
        const afterState = rendererRef.current.getFBOData();
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

  const handleTogglePlay = async (): Promise<void> => {
    if (isPlaying) {
      stopAudio();
    } else {
      await rendererRef.current?.triggerSynthesis();
      await playAudio();
      setIsPlaying(true);
    }
  };

  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });

    if (canvasContainerRef.current) {
      resizeObserver.observe(canvasContainerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const animate = () => {
      if (playbackLineRef.current) {
        const spectrogramData = store.get(spectrogramDataAtom);
        const zoomPower = store.get(zoomPowerAtom);
        const scroll = store.get(scrollAtom);
        const playbackTime = store.get(playbackTimeAtom);

        if (spectrogramData && canvasSize.width > 0) {
          playbackLineRef.current.style.display = "block";
          const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
          const progress = playbackTime / totalDuration;
          const screenCoords = zoomedToScreen(new Vector2(progress, 0), zoomPower, scroll);
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
      }
      animationFrameIdRef.current = requestAnimationFrame(animate);
    };

    if (isPlaying) {
      animationFrameIdRef.current = requestAnimationFrame(animate);
    } else {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
      if (playbackLineRef.current) {
        playbackLineRef.current.style.display = "none";
      }
    }

    return () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, [isPlaying, canvasSize]);

  return (
    <Flex direction="column" style={{ flex: 1 }}>
      <Box
        style={{ flex: 1, position: "relative", cursor: "none" }}
        ref={canvasContainerRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleCanvasMouseDown}
        onMouseUp={handleCanvasMouseUp}
      >
        <Canvas frameloop="demand">
          <Renderer ref={rendererRef} />
        </Canvas>
        <div
          ref={playbackLineRef}
          style={{
            position: "absolute",
            top: 0,
            width: "1px",
            backgroundColor: "white",
            height: "100%",
            pointerEvents: "none",
            display: "none", // Initially hidden
          }}
        />
      </Box>

      <Paper h={80} p="md" radius={0} bg="dark.7">
        <Flex align="center" justify="center" gap="md">
          <NumberInput w={100} value={bpm} onChange={(val) => setBpm(Number(val))} />
          <ActionIcon onClick={handleTogglePlay} size="lg">
            {isPlaying ? <Square /> : <Play />}
          </ActionIcon>
          <ActionIcon onClick={() => setLoop(!loop)} size="lg" variant={loop ? "filled" : "outline"}>
            <Repeat />
          </ActionIcon>
          <Text ff="monospace" size="xl">
            {formatTime(playbackTime)}
          </Text>
        </Flex>
      </Paper>
    </Flex>
  );
};
