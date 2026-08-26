import type { EffectItem } from "../effects/types";
import { NEUTRAL_ALGORITHM } from "./constants";
import { createDefaultStep, type BrushStep } from "../parameters";
import { DEFAULT_PALETTE_ID } from "../store/palette-id";
import type { SpectrogramData, State } from "../store/types";
import type { Selection } from "./selection";

/** The level the app's own eraser drops a region to. */
const WIPE_GAIN_DB = -80;

/** What a region stroke needs to turn a rectangle in seconds and pitch UV into brush sizes. */
export interface StrokeGeometry {
  bpm: number;
  totalDuration: number;
  spec: SpectrogramData;
}

/** The aim point a region stroke is dispatched at: its bottom-left corner. */
export function regionAim(rect: Selection, geometry: StrokeGeometry): { aimX: number; aimY: number } {
  return { aimX: rect.start / geometry.totalDuration, aimY: rect.pitchLo };
}

/**
 * One step shaped exactly like `rect`. The envelope defaults are already a
 * rectangle anchored at its corner, so only the sizes and the work the step
 * does have to be set.
 */
function regionStep(name: string, rect: Selection, geometry: StrokeGeometry, effects: EffectItem[]): BrushStep {
  const { bpm, spec } = geometry;
  const secondsPerBeat = 60 / bpm;
  const bandsPerSemitone = spec.bandsPerOctave / 12;

  const step = createDefaultStep(name);
  const writable: Record<string, unknown> = step;
  writable.brushSizeTime = (rect.end - rect.start) / secondsPerBeat;
  writable.brushSizePitch = ((rect.pitchHi - rect.pitchLo) * spec.numBands) / bandsPerSemitone;
  writable.brushIntensity = 100;
  writable.brushIterations = 1;
  writable.brushPan = 0;
  writable.brushWrapMode = 0;
  writable.accumulate = false;
  writable.effects = effects;
  return step;
}

/**
 * Replaces the active brush with `step`, leaving the rest of the state alone.
 * The selection is dropped: a region stroke's rectangle is its own extent, and
 * a paste must be able to land outside the selection it was copied from.
 */
function withStep(state: State, step: BrushStep): State {
  return {
    ...state,
    filesSelection: {},
    brushes: [
      {
        id: "selection-stroke",
        name: step.name,
        paletteId: DEFAULT_PALETTE_ID,
        color: { hue: "orange", variation: 0 },
        hotkey: null,
        steps: [step],
        linkedParams: [],
        libraryId: null,
        macroNames: ["Macro 1", "Macro 2", "Macro 3", "Macro 4"],
        macroValues: [50, 50, 50, 50],
      },
    ],
    activeBrushIndex: 0,
    activeStepIndex: 0,
  };
}

/** A stroke that wipes `rect`, the way the eraser brush does. */
export function silenceStrokeState(state: State, rect: Selection, geometry: StrokeGeometry): State {
  return withStep(
    state,
    regionStep("Silence", rect, geometry, [
      { id: "selection-silence", effect: "dynamics", enabled: true, params: { dynamicsGainDb: WIPE_GAIN_DB } },
    ]),
  );
}

/**
 * A stroke that writes the clipboard into `rect`. The source position is fixed
 * rather than following the stroke, so the copied corner lands under the
 * brush's corner wherever the brush is put down.
 */
export function pasteStrokeState(
  state: State,
  rect: Selection,
  geometry: StrokeGeometry,
  source: { path: string; timeFraction: number; pitchFraction: number },
): State {
  const step = regionStep("Paste", rect, geometry, [
    { id: "selection-paste", effect: "passthrough", enabled: true, params: {} },
  ]);
  const writable: Record<string, unknown> = step;
  writable.sourceFile = { path: source.path };
  writable.sourcePositionMode = "fixed";
  writable.sourceTimeOffset = source.timeFraction * 100;
  writable.sourcePitchOffset = source.pitchFraction * 100;
  // The faithful warp, pinned: a paste is a translation, not a brush choice.
  writable.algorithm = NEUTRAL_ALGORITHM;
  return withStep(state, step);
}
