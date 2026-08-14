import { zoomedToScreen } from "@/lib/utils";
import { useStore } from "@/store";
import { openFiles } from "@renderer/store/files";
import { useEffect, useRef } from "react";
import { Vector2 } from "three";

export const LOOP_COLOUR = "rgba(255, 255, 255, 0.5)";

/** The loop drag, over the time legend rather than the canvas. */
export const LOOP_DRAG_COLOUR = "rgba(255, 255, 255, 0.3)";

interface LoopRegionProps {
  fileId: string;
}

export const LoopRegion = ({ fileId }: LoopRegionProps) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const file = openFiles[fileId];
  const loopRegion = useStore((state) => state.filesLoopRegion[fileId] ?? null);
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
    // An edge scrolled off screen draws no line, so the clamp never reads as a
    // loop boundary that isn't there.
    overlayRef.current.style.borderLeftWidth = screenStart.x >= 0 ? "1px" : "0";
    overlayRef.current.style.borderRightWidth = screenEnd.x <= 1 ? "1px" : "0";
  }, [loopRegion, zoom, offset, fileId, file]);

  return (
    <div
      ref={overlayRef}
      style={{
        position: "absolute",
        top: 0,
        height: "100%",
        boxSizing: "border-box",
        borderStyle: "solid",
        borderColor: LOOP_COLOUR,
        borderTopWidth: 0,
        borderBottomWidth: "3px",
        borderLeftWidth: "1px",
        borderRightWidth: "1px",
        pointerEvents: "none",
        display: "none",
        zIndex: 10,
      }}
    />
  );
};
