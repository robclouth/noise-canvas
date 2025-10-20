import { zoomedToScreen } from "@/lib/utils";
import { openFiles, useStore } from "@/store";
import { useEffect, useRef } from "react";
import { Vector2 } from "three";

interface PlaybackStartLineProps {
  fileId: string;
}

export const PlaybackStartLine = ({ fileId }: PlaybackStartLineProps) => {
  const lineRef = useRef<HTMLDivElement>(null);
  const file = openFiles[fileId];
  const filePath = file?.filePath;
  const playbackStartTime = useStore((state) => (filePath ? state.fileSettings[filePath]?.playbackStartTime : 0));
  const zoom = useStore((state) => (filePath ? state.fileSettings[filePath]?.zoom : 0));
  const offset = useStore((state) => (filePath ? state.fileSettings[filePath]?.offset : 0));

  useEffect(() => {
    if (!lineRef.current || !file) return;

    const duration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;
    const startTime = playbackStartTime || 0;

    // Convert time to UV coordinate (zoomed space)
    const zoomedUv = new Vector2(startTime / duration, 0.5);

    // Convert from zoomed coordinates to screen coordinates
    const screenUv = zoomedToScreen(zoomedUv, zoom, offset);

    // Update position - hide if outside visible range
    if (screenUv.x >= 0 && screenUv.x <= 1) {
      lineRef.current.style.left = `${screenUv.x * 100}%`;
      lineRef.current.style.display = "block";
    } else {
      lineRef.current.style.display = "none";
    }
  }, [playbackStartTime, zoom, offset, fileId, file]);

  return (
    <div
      ref={lineRef}
      style={{
        position: "absolute",
        top: 0,
        width: 0,
        height: "100%",
        pointerEvents: "none",
        display: "none",
        zIndex: 999,
        borderLeft: "1px dashed rgba(150, 150, 255, 0.8)",
        backgroundImage: "none",
      }}
    />
  );
};
