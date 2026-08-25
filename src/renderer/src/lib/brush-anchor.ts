import { BRUSH_ANCHOR_MODE_CENTER, isOnsetGrid } from "./constants";
import { resolveBrushFootprint, swungGridCellWidthUv, type ResolvedBrushFootprint } from "./utils";
import type { State } from "@renderer/store/types";

/** The settings that decide where the cursor sits on a brush. */
export interface BrushAnchorSettings {
  anchorMode: number;
  brushSizeTime: number;
  gridSizeBeats: number;
  snapTime: boolean;
}

// Converts a user-facing aim UV into the brush's bottom-left UV (the stroke
// origin the shaders expect) for an already-resolved footprint. Corner mode
// returns the aim as-is. Center mode treats the aim as the brush's visual
// center and subtracts half the footprint. Full-size axes anchor to 0
// regardless of cursor, so the offset is skipped on those axes.
export function footprintAimToBlUv(
  aimX: number,
  aimY: number,
  footprint: ResolvedBrushFootprint,
  settings: BrushAnchorSettings,
): { blX: number; blY: number } {
  if (settings.anchorMode !== BRUSH_ANCHOR_MODE_CENTER) {
    return { blX: aimX, blY: aimY };
  }
  // A Grid-size brush on the onset grid runs from the hit to the next one, and
  // the aim is already snapped onto the hit — an onset is a position rather
  // than a cell to sit inside — so the time axis stays corner-anchored.
  const onsetAnchored = isOnsetGrid(settings.gridSizeBeats) && settings.brushSizeTime <= 0 && settings.snapTime;
  return {
    blX: footprint.fullTime || onsetAnchored ? aimX : aimX - footprint.sizeUv.x / 2,
    blY: footprint.fullPitch ? aimY : aimY - footprint.sizeUv.y / 2,
  };
}

/** The rectangle every step of the brush paints inside, for one aim point. */
export interface BrushUnion {
  /** Bottom-left origin of the union, in pitch UV. */
  blX: number;
  blY: number;
  /** Extent of the union, in UV. */
  sizeUvX: number;
  sizeUvY: number;
  /** Whether any step spans the whole time axis. */
  fullTime: boolean;
}

/**
 * The union of every step's brush rectangle for one aim point. Size and anchor
 * mode are per-step, so a brush covers the steps' rectangles together rather
 * than any one of them.
 */
export function brushUnionForAim(
  state: State,
  aimX: number,
  aimY: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
): BrushUnion {
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  if (steps.length === 0) return { blX: aimX, blY: aimY, sizeUvX: 0, sizeUvY: 0, fullTime: false };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let fullTime = false;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as Record<string, unknown>;
    const footprint = resolveBrushFootprint({
      brushSizeTime: (step?.brushSizeTime as number | undefined) ?? state.brushSizeTime,
      brushSizePitch: (step?.brushSizePitch as number | undefined) ?? state.brushSizePitch,
      gridSizeBeats: state.gridSizeBeats,
      gridSizeSemis: state.gridSizeSemis,
      bpm,
      totalDuration,
      bandsPerOctave,
      numBands,
    });
    const { blX, blY } = aimUvToBrushBlUv(state, aimX, aimY, bpm, totalDuration, bandsPerOctave, numBands, index);
    const originX = footprint.fullTime ? 0 : blX;
    const originY = footprint.fullPitch ? 0 : blY;
    minX = Math.min(minX, originX);
    minY = Math.min(minY, originY);
    maxX = Math.max(maxX, originX + footprint.sizeUv.x);
    maxY = Math.max(maxY, originY + footprint.sizeUv.y);
    if (footprint.fullTime) fullTime = true;
  }
  return { blX: minX, blY: minY, sizeUvX: maxX - minX, sizeUvY: maxY - minY, fullTime };
}

// Converts an aim UV into the brush's bottom-left UV for one step of the active
// brush. Brush size and anchor mode are per-step parameters, so the step index
// decides the origin; it defaults to the selected step.
export function aimUvToBrushBlUv(
  state: State,
  aimX: number,
  aimY: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
  stepIndex: number = state.activeStepIndex,
): { blX: number; blY: number } {
  const step = state.brushes[state.activeBrushIndex]?.steps?.[stepIndex] as Record<string, unknown> | undefined;
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
  if (swungTimeUv !== null) footprint.sizeUv.x = swungTimeUv;
  return footprintAimToBlUv(aimX, aimY, footprint, {
    anchorMode,
    brushSizeTime,
    gridSizeBeats: state.gridSizeBeats,
    snapTime: state.snapTime,
  });
}
