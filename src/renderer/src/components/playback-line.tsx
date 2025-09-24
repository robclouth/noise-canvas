import { playbackTimeAtom } from "@/audio-manager";
import { isPlayingAtom, scrollAtom, store, zoomPowerAtom } from "@/store";
import type { OpenFile } from "@renderer/types";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { zoomedToScreen } from "./brushes/common";

interface PlaybackLineProps {
  file: OpenFile;
}

export const PlaybackLine = ({ file }: PlaybackLineProps) => {
  const lineRef = useRef<HTMLDivElement>(null);
  const isPlaying = useAtomValue(isPlayingAtom);
  const animationFrameIdRef = useRef<number | null>(null);

  useEffect(() => {
    const animate = () => {
      if (lineRef.current) {
        const { spectrogramData } = file;
        const zoomPower = store.get(zoomPowerAtom);
        const scroll = store.get(scrollAtom);
        const playbackTime = store.get(playbackTimeAtom);

        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const progress = playbackTime / totalDuration;
        const screenCoords = zoomedToScreen(new THREE.Vector2(progress, 0), zoomPower, scroll);

        lineRef.current.style.display = "block";
        lineRef.current.style.left = `${screenCoords.x * 100}%`;
      }
      animationFrameIdRef.current = requestAnimationFrame(animate);
    };

    if (isPlaying) {
      animationFrameIdRef.current = requestAnimationFrame(animate);
    } else {
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
      if (lineRef.current) lineRef.current.style.display = "none";
    }

    return () => {
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
    };
  }, [isPlaying, file]);

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
      }}
    />
  );
};
