import { zoomedToScreen } from "@/lib/utils";
import { useStore } from "@/store";
import { openFiles } from "@renderer/store/files";
import { useEffect, useRef } from "react";
import { Vector2 } from "three";

interface PlaybackLineProps {
  fileId: string;
}

export const PlaybackLine = ({ fileId }: PlaybackLineProps) => {
  const lineRef = useRef<HTMLDivElement>(null);
  const animationFrameId = useRef<number | null>(null);
  const isPlaying = useStore((state) => state.isPlaying);
  const loop = useStore((state) => state.loop);
  const fileData = openFiles[fileId];
  const duration = fileData?.spectrogramData ? fileData.spectrogramData.numFrames / fileData.spectrogramData.sampleRate : 0;

  useEffect(() => {
    if (!isPlaying) {
      if (animationFrameId.current !== null) {
        cancelAnimationFrame(animationFrameId.current);
        animationFrameId.current = null;
      }
      return;
    }

    const updatePlaybackPosition = () => {
      const currentTime = useStore.getState().getPlaybackTime();

      if (lineRef.current) {
        // Convert time to UV coordinate (zoomed space)
        const zoomedUv = new Vector2(currentTime / duration, 0.5);

        // Get per-file zoom and offset from store
        const state = useStore.getState();
        const zoom = state.filesZoom[fileId];
        const offset = state.filesOffset[fileId];

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
