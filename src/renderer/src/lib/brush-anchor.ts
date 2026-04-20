import { BRUSH_ANCHOR_MODE_CENTER } from "./constants";
import { resolveBrushFootprint } from "./utils";
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
  return {
    blX: footprint.fullTime ? aimX : aimX - footprint.sizeUv.x / 2,
    blY: footprint.fullPitch ? aimY : aimY - footprint.sizeUv.y / 2,
  };
}
