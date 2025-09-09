import { RefObject, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useAtomValue } from "jotai";
import * as THREE from "three";
import { isPlayingAtom, scrollAtom, zoomPowerAtom, store, OpenFile } from "@/store";
import { playbackTimeAtom } from "@/audio-manager";
import { zoomedToScreen } from "./brushes/common";

interface PlaybackLineProps {
  file: OpenFile;
  containerRef: RefObject<HTMLDivElement | null>;
}

export const PlaybackLine = ({ file, containerRef }: PlaybackLineProps) => {
  const lineRef = useRef<HTMLDivElement>(null);
  const isPlaying = useAtomValue(isPlayingAtom);
  const animationFrameIdRef = useRef<number | null>(null);

  useEffect(() => {
    const animate = () => {
      if (lineRef.current && containerRef.current) {
        const { spectrogramData } = file;
        const zoomPower = store.get(zoomPowerAtom);
        const scroll = store.get(scrollAtom);
        const playbackTime = store.get(playbackTimeAtom);
        const containerWidth = containerRef.current.clientWidth;

        if (containerWidth > 0) {
          const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
          const progress = playbackTime / totalDuration;
          const screenCoords = zoomedToScreen(new THREE.Vector2(progress, 0), zoomPower, scroll);
          const left = screenCoords.x * containerWidth;

          if (left < 0 || left > containerWidth) {
            lineRef.current.style.display = "none";
          } else {
            lineRef.current.style.display = "block";
            lineRef.current.style.left = `${left}px`;
          }
        } else {
          lineRef.current.style.display = "none";
        }
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
  }, [isPlaying, file, containerRef]);

  if (!containerRef.current) return null;

  return createPortal(
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
    />,
    containerRef.current,
  );
};
