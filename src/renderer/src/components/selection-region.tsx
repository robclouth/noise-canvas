import { pitchUvToViewUvY, zoomedToScreen } from "@/lib/utils";
import { maskBoundarySegments } from "@/lib/selection-mask";
import { maskRowRuns, type Selection, type SelectionMask } from "@/lib/selection";
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
// One dash for every selection outline — rectangle, lasso, wand, in progress
// or committed — so no two shapes read as different kinds of selection.
const DASH_PX = 4;

interface SelectionRegionProps {
  fileId: string;
}

// How the visible overlay window sits inside the selection's full bounding
// rectangle: the rectangle can run off screen, so shapes draw at full-box
// scale shifted by the clipped-away part.
interface OverlayView {
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  offsetX: number;
  offsetY: number;
  dpr: number;
}

function beginOverlayDraw(canvas: HTMLCanvasElement, view: OverlayView): CanvasRenderingContext2D | null {
  canvas.width = Math.max(1, Math.round(view.width * view.dpr));
  canvas.height = Math.max(1, Math.round(view.height * view.dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.translate(view.offsetX * view.dpr, view.offsetY * view.dpr);
  return ctx;
}

// Draws a mask's runs and boundary, top row at the top edge, into a canvas
// covering the selection's bounding rectangle.
function drawMask(canvas: HTMLCanvasElement, mask: SelectionMask, view: OverlayView): void {
  const ctx = beginOverlayDraw(canvas, view);
  if (!ctx) return;
  const width = view.fullWidth * view.dpr;
  const rowH = (view.fullHeight * view.dpr) / mask.rows;

  ctx.fillStyle = SELECTION_FILL;
  for (let row = 0; row < mask.rows; row++) {
    const runs = maskRowRuns(mask, row);
    for (let i = 0; i + 1 < runs.length; i += 2) {
      ctx.fillRect(runs[i] * width, row * rowH, (runs[i + 1] - runs[i]) * width, rowH);
    }
  }

  ctx.strokeStyle = SELECTION_COLOUR;
  ctx.lineWidth = view.dpr;
  ctx.setLineDash([DASH_PX * view.dpr, DASH_PX * view.dpr]);
  ctx.beginPath();
  const segments = maskBoundarySegments(mask);
  for (let i = 0; i + 3 < segments.length; i += 4) {
    ctx.moveTo(segments[i] * width, segments[i + 1] * rowH);
    ctx.lineTo(segments[i + 2] * width, segments[i + 3] * rowH);
  }
  ctx.stroke();
}

// Draws an in-progress freehand path into a canvas covering its bounding
// rectangle, in the selection's own time and pitch space.
function drawPath(
  canvas: HTMLCanvasElement,
  path: { time: number; pitchUv: number }[],
  box: { start: number; end: number; pitchLo: number; pitchHi: number },
  view: OverlayView,
): void {
  const ctx = beginOverlayDraw(canvas, view);
  if (!ctx) return;
  const dpr = view.dpr;
  const spanT = Math.max(1e-9, box.end - box.start);
  const spanP = Math.max(1e-9, box.pitchHi - box.pitchLo);
  ctx.beginPath();
  for (let i = 0; i < path.length; i++) {
    const x = ((path[i].time - box.start) / spanT) * view.fullWidth * dpr;
    const y = ((box.pitchHi - path[i].pitchUv) / spanP) * view.fullHeight * dpr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = SELECTION_FILL;
  ctx.fill("evenodd");
  ctx.strokeStyle = SELECTION_COLOUR;
  ctx.lineWidth = dpr;
  ctx.setLineDash([DASH_PX * dpr, DASH_PX * dpr]);
  ctx.stroke();
}

// Draws a plain rectangle the same way the shapes draw: canvas dash and fill,
// with edges scrolled off screen falling outside the canvas.
function drawRect(canvas: HTMLCanvasElement, view: OverlayView): void {
  const ctx = beginOverlayDraw(canvas, view);
  if (!ctx) return;
  const w = view.fullWidth * view.dpr;
  const h = view.fullHeight * view.dpr;
  ctx.fillStyle = SELECTION_FILL;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = SELECTION_COLOUR;
  ctx.lineWidth = view.dpr;
  ctx.setLineDash([DASH_PX * view.dpr, DASH_PX * view.dpr]);
  ctx.strokeRect(view.dpr / 2, view.dpr / 2, w - view.dpr, h - view.dpr);
}

// One selection drawn over the canvas: a rectangle, or a shape in its
// bounding box, or an in-progress freehand path.
const SelectionBox = ({
  fileId,
  selection,
  path,
}: {
  fileId: string;
  selection: Selection | null;
  path: { time: number; pitchUv: number }[] | null;
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const file = openFiles[fileId];
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

    // Every selection paints on the canvas, so one dash serves them all. An
    // edge scrolled off screen falls outside the canvas and draws no line.
    const canvas = canvasRef.current;
    if (canvas && bounds) {
      const view = {
        width: (right - left) * bounds.width,
        height: (bottom - top) * bounds.height,
        fullWidth: (bottomRight.x - topLeft.x) * bounds.width,
        fullHeight: (bottomRight.y - topLeft.y) * bounds.height,
        offsetX: (topLeft.x - left) * bounds.width,
        offsetY: (topLeft.y - top) * bounds.height,
        dpr: Math.min(2, window.devicePixelRatio || 1),
      };
      if (path) drawPath(canvas, path, selection, view);
      else if (selection.mask) drawMask(canvas, selection.mask, view);
      else drawRect(canvas, view);
    }
  }, [selection, path, zoom, offset, zoomY, offsetY, file]);

  return (
    <div
      ref={overlayRef}
      data-selection-overlay
      style={{
        position: "absolute",
        boxSizing: "border-box",
        pointerEvents: "none",
        display: "none",
        zIndex: 11,
      }}
    >
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
    </div>
  );
};

/** The selection over the canvas; an add-gesture shows what it adds to as well. */
export const SelectionRegion = ({ fileId }: SelectionRegionProps) => {
  const committed = useStore((state) => state.filesSelection[fileId] ?? null);
  const placing = useStore((state) => (state.placing?.fileId === fileId ? state.placing.rect : null));
  const drag = useTransientStore((state) => (state.selectionDrag?.fileId === fileId ? state.selectionDrag : null));
  // A region in flight is what the shape means until it is put down.
  const active = placing ?? drag?.selection ?? committed;
  const activePath = drag?.path && drag.path.length >= 2 ? drag.path : null;
  // The selection the gesture is adding to stays on screen underneath it.
  const base = drag?.add ? committed : null;
  return (
    <>
      {base && <SelectionBox fileId={fileId} selection={base} path={null} />}
      <SelectionBox fileId={fileId} selection={active} path={activePath} />
    </>
  );
};
