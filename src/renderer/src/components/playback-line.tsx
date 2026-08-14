import { zoomedToScreen } from "@/lib/utils";
import { useStore } from "@/store";
import { openFiles } from "@renderer/store/files";
import { useCallback, useEffect, useRef } from "react";
import { Vector2 } from "three";

interface PlaybackLineProps {
  fileId: string;
}

export const PlaybackLine = ({ fileId }: PlaybackLineProps) => {
  const lineRef = useRef<HTMLDivElement>(null);
  const animationFrameId = useRef<number | null>(null);
  const isPlaying = useStore((state) => state.isPlaying);
  const loop = useStore((state) => state.loop);
  const playbackStartTime = useStore((state) => state.filesPlaybackStartTime[fileId] ?? 0);
  const zoom = useStore((state) => state.filesZoom[fileId]);
  const offset = useStore((state) => state.filesOffset[fileId]);
  const fileData = openFiles[fileId];
  const duration = fileData?.spectrogramData
    ? fileData.spectrogramData.numFrames / fileData.spectrogramData.sampleRate
    : 0;

  /** Moves the line to a time, hiding it when that time is scrolled off screen. */
  const placeAt = useCallback(
    (time: number) => {
      const line = lineRef.current;
      if (!line || duration <= 0) return;

      const screenUv = zoomedToScreen(new Vector2(time / duration, 0.5), zoom, offset);
      if (screenUv.x >= 0 && screenUv.x <= 1) {
        line.style.left = `${screenUv.x * 100}%`;
        line.style.display = "block";
      } else {
        line.style.display = "none";
      }
    },
    [duration, zoom, offset],
  );

  useEffect(() => {
    // Stopped: the line rests on the remembered start position rather than
    // disappearing, so it always says where the next Play will begin.
    if (!isPlaying) {
      placeAt(playbackStartTime);
      return;
    }

    const updatePlaybackPosition = () => {
      placeAt(useStore.getState().getPlaybackTime());
      animationFrameId.current = requestAnimationFrame(updatePlaybackPosition);
    };

    updatePlaybackPosition();

    return () => {
      if (animationFrameId.current !== null) {
        cancelAnimationFrame(animationFrameId.current);
        animationFrameId.current = null;
      }
    };
  }, [isPlaying, loop, placeAt, playbackStartTime]);

  return (
    <div
      ref={lineRef}
      style={{
        position: "absolute",
        top: 0,
        width: "1px",
        backgroundColor: "white",
        height: "100%",
        pointerEvents: "none",
        display: "none",
        zIndex: 1000,
      }}
    />
  );
};
