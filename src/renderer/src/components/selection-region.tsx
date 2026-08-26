import { pitchUvToViewUvY, zoomedToScreen } from "@/lib/utils";
import { useStore } from "@/store";
import { openFiles } from "@renderer/store/files";
import { useTransientStore } from "@renderer/store/transient";
import { useEffect, useRef } from "react";
import { Vector2 } from "three";

// Mantine orange[6]-ish, as the onset markers and the active file border use.
// Dashed, where the loop region is solid white, so a full-height selection and
// the loop region it sets stay apart when they share an edge.
export const SELECTION_COLOUR = "rgba(255, 140, 51, 0.95)";
const SELECTION_FILL = "rgba(255, 140, 51, 0.1)";
const INSET_PX = 1;

interface SelectionRegionProps {
  fileId: string;
}

/** The selection rectangle over the canvas, in time and in pitch. */
export const SelectionRegion = ({ fileId }: SelectionRegionProps) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const file = openFiles[fileId];
  const committed = useStore((state) => state.filesSelection[fileId] ?? null);
  const placing = useStore((state) => (state.placing?.fileId === fileId ? state.placing.rect : null));
  const drag = useTransientStore((state) => (state.selectionDrag?.fileId === fileId ? state.selectionDrag : null));
  // A region in flight is what the rectangle means until it is put down.
  const selection = placing ?? drag?.selection ?? committed;
  const zoom = useStore((state) => state.filesZoom[fileId]);
  const offset = useStore((state) => state.filesOffset[fileId]);
  const zoomY = useStore((state) => state.filesZoomY[fileId] ?? 0);
  const offsetY = useStore((state) => state.filesOffsetY[fileId] ?? 0);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!file?.spectrogramData || !selection) {
      overlay.style.display = "none";
      return;
    }

    const duration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;
    const zoomVec = new Vector2(zoom, zoomY);
    const offsetVec = new Vector2(offset, offsetY);

    // Pitch UV is y-up; the zoom transform works in the view's y-down space.
    const topLeft = zoomedToScreen(
      new Vector2(selection.start / duration, pitchUvToViewUvY(selection.pitchHi)),
      zoomVec,
      offsetVec,
    );
    const bottomRight = zoomedToScreen(
      new Vector2(selection.end / duration, pitchUvToViewUvY(selection.pitchLo)),
      zoomVec,
      offsetVec,
    );

    const left = Math.max(0, topLeft.x);
    const right = Math.min(1, bottomRight.x);
    const top = Math.max(0, topLeft.y);
    const bottom = Math.min(1, bottomRight.y);
    if (right <= left || bottom <= top) {
      overlay.style.display = "none";
      return;
    }

    // A full-height selection sets the loop region to its own time span, so the
    // two would draw over each other edge for edge. The inset keeps the loop
    // region's lines visible just outside the selection's.
    const bounds = overlay.parentElement?.getBoundingClientRect();
    const insetX = (right - left) * (bounds?.width ?? 0) > INSET_PX * 4 ? INSET_PX : 0;
    const insetY = (bottom - top) * (bounds?.height ?? 0) > INSET_PX * 4 ? INSET_PX : 0;

    overlay.style.display = "block";
    overlay.style.left = `calc(${left * 100}% + ${insetX}px)`;
    overlay.style.width = `calc(${(right - left) * 100}% - ${insetX * 2}px)`;
    overlay.style.top = `calc(${top * 100}% + ${insetY}px)`;
    overlay.style.height = `calc(${(bottom - top) * 100}% - ${insetY * 2}px)`;
    // An edge scrolled off screen draws no line, so the clamp never reads as a
    // selection boundary that isn't there.
    overlay.style.borderLeftWidth = topLeft.x >= 0 ? "1px" : "0";
    overlay.style.borderRightWidth = bottomRight.x <= 1 ? "1px" : "0";
    overlay.style.borderTopWidth = topLeft.y >= 0 ? "1px" : "0";
    overlay.style.borderBottomWidth = bottomRight.y <= 1 ? "1px" : "0";
  }, [selection, zoom, offset, zoomY, offsetY, file]);

  return (
    <div
      ref={overlayRef}
      style={{
        position: "absolute",
        boxSizing: "border-box",
        borderStyle: "dashed",
        borderColor: SELECTION_COLOUR,
        borderWidth: "1px",
        backgroundColor: SELECTION_FILL,
        pointerEvents: "none",
        display: "none",
        zIndex: 11,
      }}
    />
  );
};
