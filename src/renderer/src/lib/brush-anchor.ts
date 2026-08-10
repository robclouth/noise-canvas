import { BRUSH_ANCHOR_MODE_CENTER, isOnsetGrid } from "./constants";
import { resolveBrushFootprint, swungGridCellWidthUv } from "./utils";
import type { State } from "@renderer/store/types";

// Converts a user-facing aim UV into the brush's bottom-left UV (the stroke
// origin the shaders expect). Corner mode returns the aim as-is. Center mode
// treats the aim as the brush's visual center and subtracts half the
// footprint. Full-size axes anchor to 0 regardless of cursor, so the offset
// is skipped on those axes.
export function aimUvToBrushBlUv(
  state: State,
  aimX: number,
  aimY: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
): { blX: number; blY: number } {
  const step = state.brushes[state.activeBrushIndex]?.steps?.[state.activeStepIndex] as
    | Record<string, unknown>
    | undefined;
  const anchorMode = (step?.brushAnchorMode as number | undefined) ?? state.brushAnchorMode;
  if (anchorMode !== BRUSH_ANCHOR_MODE_CENTER) {
    return { blX: aimX, blY: aimY };
  }
  const brushSizeTime = (step?.brushSizeTime as number | undefined) ?? state.brushSizeTime;
  const brushSizePitch = (step?.brushSizePitch as number | undefined) ?? state.brushSizePitch;
  const footprint = resolveBrushFootprint({
    brushSizeTime,
    brushSizePitch,
    gridSizeBeats: state.gridSizeBeats,
    gridSizeSemis: state.gridSizeSemis,
    bpm,
    totalDuration,
    bandsPerOctave,
    numBands,
  });
  // In Grid mode with time-snap on, the brush fills the swung cell it lands in,
  // so center it on that cell's width rather than the constant grid width.
  const swungTimeUv = swungGridCellWidthUv(
    aimX,
    { brushSizeTime, gridSizeBeats: state.gridSizeBeats, gridSwing: state.gridSwing, snapTime: state.snapTime },
    bpm,
    totalDuration,
  );
  const timeSizeUv = swungTimeUv ?? footprint.sizeUv.x;
  // A Grid-size brush on the onset grid runs from the hit to the next one, and
  // the aim is already snapped onto the hit — an onset is a position rather
  // than a cell to sit inside — so the time axis stays corner-anchored.
  const onsetAnchored = isOnsetGrid(state.gridSizeBeats) && brushSizeTime <= 0 && state.snapTime;
  return {
    blX: footprint.fullTime || onsetAnchored ? aimX : aimX - timeSizeUv / 2,
    blY: footprint.fullPitch ? aimY : aimY - footprint.sizeUv.y / 2,
  };
}
