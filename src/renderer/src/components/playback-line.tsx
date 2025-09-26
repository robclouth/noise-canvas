import { openFiles, useStore } from "@/store";
import { useEffect, useRef } from "react";

interface PlaybackLineProps {
  filePath: string;
}

export const PlaybackLine = ({ filePath }: PlaybackLineProps) => {
  const lineRef = useRef<HTMLDivElement>(null);
  const isPlaying = useStore((state) => state.isPlaying);
  const duration = openFiles[filePath].spectrogramData.numFrames / openFiles[filePath].spectrogramData.sampleRate;

  useEffect(() => {
    const unsubPlaybackTime = useStore.subscribe(
      (state) => state.playbackTime,
      (playbackTime) => {
        if (lineRef.current) {
          lineRef.current.style.left = `${(playbackTime / duration) * 100}%`;
        }
      },
    );

    return () => {
      unsubPlaybackTime();
    };
  }, [isPlaying, duration]);

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
