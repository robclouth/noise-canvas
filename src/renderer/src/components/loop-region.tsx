import { zoomedToScreen } from "@/lib/utils";
import { useStore } from "@/store";
import { openFiles } from "@renderer/store/files";
import { useEffect, useRef } from "react";
import { Vector2 } from "three";

interface LoopRegionProps {
  fileId: string;
}

export const LoopRegion = ({ fileId }: LoopRegionProps) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const file = openFiles[fileId];
  const loopRegion = useStore((state) => state.loopRegion);
  const zoom = useStore((state) => state.filesZoom[fileId]);
  const offset = useStore((state) => state.filesOffset[fileId]);

  useEffect(() => {
    if (!overlayRef.current || !file?.spectrogramData || !loopRegion) {
      if (overlayRef.current) overlayRef.current.style.display = "none";
      return;
    }

    const duration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;
    const regionStart = Math.max(0, Math.min(loopRegion.start, duration));
    const regionEnd = Math.max(regionStart, Math.min(loopRegion.end, duration));

    const screenStart = zoomedToScreen(new Vector2(regionStart / duration, 0.5), zoom, offset);
    const screenEnd = zoomedToScreen(new Vector2(regionEnd / duration, 0.5), zoom, offset);

    if (screenEnd.x < 0 || screenStart.x > 1) {
      overlayRef.current.style.display = "none";
      return;
    }

    const clampedLeft = Math.max(0, screenStart.x);
    const clampedRight = Math.min(1, screenEnd.x);
    const widthFraction = clampedRight - clampedLeft;

    if (widthFraction <= 0) {
      overlayRef.current.style.display = "none";
      return;
    }

    overlayRef.current.style.display = "block";
    overlayRef.current.style.left = `${clampedLeft * 100}%`;
    overlayRef.current.style.width = `${widthFraction * 100}%`;
  }, [loopRegion, zoom, offset, fileId, file]);

  return (
    <div
      ref={overlayRef}
      style={{
        position: "absolute",
        top: 0,
        height: "100%",
        background: "rgba(255, 150, 0, 0.15)",
        pointerEvents: "none",
        display: "none",
        zIndex: 10,
      }}
    />
  );
};
