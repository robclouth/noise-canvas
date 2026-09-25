import { getFileOnsets } from "@renderer/lib/file-onsets";
import { BRUSH_SIZE_PITCH_FULL, BRUSH_SIZE_TIME_FULL, MAX_FIXED_BRUSH_BEATS, unitsToUv } from "@renderer/lib/utils";
import type { BrushStep } from "@renderer/parameters";
import type { LoopRegion, SpectrogramData, State } from "@renderer/store/types";
import { resolvePitchCells, resolveTimeCells } from "./grid-cells";

export interface GridFillTarget {
  fileId: string;
  spectrogramData: SpectrogramData;
  bpm: number;
  totalDuration: number;
  /** The span to fill, in seconds. The whole file when absent. */
  region: LoopRegion | null;
}

/** Where one stroke is aimed, in pitch UV. Each step anchors its own brush to it. */
export interface FillAnchor {
  aimX: number;
  aimY: number;
}

export interface GridFill {
  anchors: FillAnchor[];
  /** The state every stroke paints from. One fill is one brush, so they share it. */
  state: State;
}

function activeStep(state: State): Record<string, unknown> | undefined {
  return state.brushes[state.activeBrushIndex]?.steps?.[state.activeStepIndex] as Record<string, unknown> | undefined;
}

function stepNumber(state: State, key: "brushSizeTime" | "brushSizePitch"): number {
  const value = activeStep(state)?.[key];
  return typeof value === "number" ? value : state[key];
}

/**
 * The brush the fill paints with. On an axis whose snapping is off, a brush that
 * tracks the grid is stretched to span the whole range. Every other case leaves
 * the brush as the user set it.
 */
function fillState(state: State, timeSpanBeats: number, hasRegion: boolean, cellBeats: number | null): State {
  const overrides: { brushSizeTime?: number; brushSizePitch?: number } = {};

  if (!state.snapTime && stepNumber(state, "brushSizeTime") <= 0) {
    // Full anchors to the file's edge, so a region takes its measured length
    // instead or the stroke would paint past the region. A region longer than
    // a brush can be is taken in cells, each stroke one cell long.
    overrides.brushSizeTime =
      cellBeats !== null
        ? Math.min(cellBeats, MAX_FIXED_BRUSH_BEATS)
        : hasRegion
          ? Math.min(timeSpanBeats, MAX_FIXED_BRUSH_BEATS)
          : BRUSH_SIZE_TIME_FULL;
  }
  if (!state.snapPitch && stepNumber(state, "brushSizePitch") <= 0) {
    overrides.brushSizePitch = BRUSH_SIZE_PITCH_FULL;
  }
  if (overrides.brushSizeTime === undefined && overrides.brushSizePitch === undefined) return state;

  const brush = state.brushes[state.activeBrushIndex];
  if (!brush) return state;

  const steps = brush.steps.map((step, index) => {
    if (index !== state.activeStepIndex) return step;
    const next: BrushStep = { ...step };
    const writable: Record<string, unknown> = next;
    if (overrides.brushSizeTime !== undefined) writable.brushSizeTime = overrides.brushSizeTime;
    if (overrides.brushSizePitch !== undefined) writable.brushSizePitch = overrides.brushSizePitch;
    return next;
  });

  const brushes = [...state.brushes];
  brushes[state.activeBrushIndex] = { ...brush, steps };
  return { ...state, ...overrides, brushes };
}

/**
 * Every place the active brush lands on the grid, and the state it paints from.
 * Time cells come from the time grid — beats, swing, or the file's onsets — and
 * pitch rows from the pitch grid or the selected scale. Stroke size is left to
 * the renderer.
 */
export function resolveGridFill(state: State, target: GridFillTarget): GridFill {
  const { spectrogramData, bpm, totalDuration, region } = target;
  const { bandsPerOctave, numBands, minFreq } = spectrogramData;

  const secondsPerBeat = 60 / bpm;
  const timeRange = {
    min: Math.max(0, region?.start ?? 0),
    max: Math.min(totalDuration, region?.end ?? totalDuration),
  };
  const pitchRange = { min: 0, max: (numBands / bandsPerOctave) * 12 };
  if (!(timeRange.max > timeRange.min)) return { anchors: [], state };

  let timeCells = resolveTimeCells(timeRange, {
    gridSizeBeats: state.gridSizeBeats,
    gridSwing: state.gridSwing,
    snapTime: state.snapTime,
    bpm,
    onsets: getFileOnsets(target.fileId),
  });
  // With time snapping off the span is one cell. A region longer than a
  // brush can be is cut into equal cells a brush can span, and the brush is
  // sized to one.
  let cellBeats: number | null = null;
  const maxSeconds = MAX_FIXED_BRUSH_BEATS * secondsPerBeat;
  const spanSeconds = timeRange.max - timeRange.min;
  if (!state.snapTime && stepNumber(state, "brushSizeTime") <= 0 && region !== null && spanSeconds > maxSeconds) {
    const count = Math.ceil(spanSeconds / maxSeconds);
    const cellSeconds = spanSeconds / count;
    timeCells = Array.from({ length: count }, (_, index) => ({
      start: timeRange.min + index * cellSeconds,
      size: cellSeconds,
    }));
    cellBeats = cellSeconds / secondsPerBeat;
  }
  const pitchCells = resolvePitchCells(pitchRange, {
    gridSizeSemis: state.gridSizeSemis,
    snapPitch: state.snapPitch,
    scaleTonic: state.scaleTonic,
    scaleType: state.scaleType,
    minFreq,
  });

  const painted = fillState(state, (timeRange.max - timeRange.min) / secondsPerBeat, region !== null, cellBeats);
  if (!painted.brushes[painted.activeBrushIndex]) return { anchors: [], state: painted };

  const anchors: FillAnchor[] = [];
  for (const timeCell of timeCells) {
    for (const pitchCell of pitchCells) {
      const aim = unitsToUv(
        timeCell.start / secondsPerBeat,
        pitchCell.start,
        bpm,
        totalDuration,
        bandsPerOctave,
        numBands,
      );
      anchors.push({ aimX: aim.x, aimY: aim.y });
    }
  }
  return { anchors, state: painted };
}
