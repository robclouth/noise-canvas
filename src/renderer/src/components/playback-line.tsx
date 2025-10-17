import { zoomedToScreen } from "@/lib/utils";
import { openFiles, player, useStore } from "@/store";
import { useEffect, useRef } from "react";
import { Vector2 } from "three";
import * as Tone from "tone";

interface PlaybackLineProps {
  fileId: string;
}

export const PlaybackLine = ({ fileId }: PlaybackLineProps) => {
  const lineRef = useRef<HTMLDivElement>(null);
  const animationFrameId = useRef<number | null>(null);
  const isPlaying = useStore((state) => state.isPlaying);
  const loop = useStore((state) => state.loop);
  const duration = openFiles[fileId].spectrogramData.numFrames / openFiles[fileId].spectrogramData.sampleRate;

  useEffect(() => {
    if (!isPlaying) {
      if (animationFrameId.current !== null) {
        cancelAnimationFrame(animationFrameId.current);
        animationFrameId.current = null;
      }
      return;
    }

    const updatePlaybackPosition = () => {
      const file = openFiles[fileId];
      const audioBuffer = file?.audioBuffer;
      let currentTime = Tone.getTransport().seconds;

      if (loop && audioBuffer && player.state === "started") {
        currentTime %= audioBuffer.duration;
      }

      if (lineRef.current) {
        // Convert time to UV coordinate (zoomed space)
        const zoomedUv = new Vector2(currentTime / duration, 0.5);

        // Get per-file zoom and offset from store
        const state = useStore.getState();
        const zoom = state.fileSettings[openFiles[fileId].filePath].zoom;
        const offset = state.fileSettings[openFiles[fileId].filePath].offset;

        // Convert from zoomed coordinates to screen coordinates
        const screenUv = zoomedToScreen(zoomedUv, zoom, offset);

        // Update position - hide if outside visible range
        if (screenUv.x >= 0 && screenUv.x <= 1) {
          lineRef.current.style.left = `${screenUv.x * 100}%`;
          lineRef.current.style.display = "block";
        } else {
          lineRef.current.style.display = "none";
        }
      }

      animationFrameId.current = requestAnimationFrame(updatePlaybackPosition);
    };

    updatePlaybackPosition();

    return () => {
      if (animationFrameId.current !== null) {
        cancelAnimationFrame(animationFrameId.current);
        animationFrameId.current = null;
      }
    };
  }, [isPlaying, loop, duration, fileId]);

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
        display: isPlaying ? "block" : "none",
        zIndex: 1000,
      }}
    />
  );
};
