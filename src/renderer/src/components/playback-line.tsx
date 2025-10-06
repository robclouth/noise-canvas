import { openFiles, player, useStore } from "@/store";
import { useEffect, useRef } from "react";
import * as Tone from "tone";

interface PlaybackLineProps {
  filePath: string;
}

export const PlaybackLine = ({ filePath }: PlaybackLineProps) => {
  const lineRef = useRef<HTMLDivElement>(null);
  const animationFrameId = useRef<number | null>(null);
  const isPlaying = useStore((state) => state.isPlaying);
  const loop = useStore((state) => state.loop);
  const duration = openFiles[filePath].spectrogramData.numFrames / openFiles[filePath].spectrogramData.sampleRate;

  useEffect(() => {
    if (!isPlaying) {
      if (animationFrameId.current !== null) {
        cancelAnimationFrame(animationFrameId.current);
        animationFrameId.current = null;
      }
      return;
    }

    const updatePlaybackPosition = () => {
      const file = openFiles[filePath];
      const audioBuffer = file?.audioBuffer;
      let currentTime = Tone.getTransport().seconds;

      if (loop && audioBuffer && player.state === "started") {
        currentTime %= audioBuffer.duration;
      }

      if (lineRef.current) {
        lineRef.current.style.left = `${(currentTime / duration) * 100}%`;
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
  }, [isPlaying, loop, duration, filePath]);

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
