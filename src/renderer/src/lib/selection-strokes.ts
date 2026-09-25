import type { EffectItem } from "../effects/types";
import { NEUTRAL_ALGORITHM } from "./constants";
import { createDefaultStep, type BrushStep } from "../parameters";
import { DEFAULT_PALETTE_ID } from "../store/palette-id";
import type { SpectrogramData, State } from "../store/types";
import type { Selection } from "./selection";
import { MAX_FIXED_BRUSH_BEATS } from "./utils";

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
 * a paste must be able to land outside the selection it was copied from. A
 * masked rectangle stays behind as the stroke's own clip instead — the shader's
 * membership test is what gives the stroke its shape.
 */
function withStep(state: State, step: BrushStep, clip: { fileId: string; rect: Selection } | null): State {
  return {
    ...state,
    filesSelection: clip?.rect.mask ? { [clip.fileId]: clip.rect } : {},
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

/** One stroke of a region edit: the state it paints with, and the part of the region it covers. */
export type RegionStroke = { state: State; rect: Selection };

/**
 * `rect` cut into equal parts along time, none longer than a brush can be
 * before it means the whole file. Most regions are one part.
 */
export function regionParts(rect: Selection, geometry: StrokeGeometry): Selection[] {
  const maxSeconds = (MAX_FIXED_BRUSH_BEATS * 60) / geometry.bpm;
  const count = Math.max(1, Math.ceil((rect.end - rect.start) / maxSeconds));
  const length = (rect.end - rect.start) / count;
  return Array.from({ length: count }, (_, index) => ({
    ...rect,
    start: rect.start + index * length,
    end: index === count - 1 ? rect.end : rect.start + (index + 1) * length,
  }));
}

/**
 * Strokes that wipe `rect`, the way the eraser brush does. A masked region
 * keeps the whole rectangle as each part's clip, so the mask lands as drawn.
 */
export function silenceStrokes(
  state: State,
  rect: Selection,
  geometry: StrokeGeometry,
  fileId: string,
): RegionStroke[] {
  return regionParts(rect, geometry).map((part) => ({
    state: withStep(
      state,
      regionStep("Silence", part, geometry, [
        { id: "selection-silence", effect: "dynamics", enabled: true, params: { dynamicsGainDb: WIPE_GAIN_DB } },
      ]),
      { fileId, rect },
    ),
    rect: part,
  }));
}

/**
 * Strokes that write the clipboard into `rect`. The source position is fixed
 * rather than following the stroke, so the copied corner lands under the
 * brush's corner wherever the brush is put down; a later part reads as much
 * further into the clipboard as it starts into the region, `secondsPerFraction`
 * converting the clipboard's length.
 */
export function pasteStrokes(
  state: State,
  rect: Selection,
  geometry: StrokeGeometry,
  source: { path: string; timeFraction: number; pitchFraction: number; secondsPerFraction: number },
  fileId: string,
): RegionStroke[] {
  return regionParts(rect, geometry).map((part) => {
    const step = regionStep("Paste", part, geometry, [
      { id: "selection-paste", effect: "passthrough", enabled: true, params: {} },
    ]);
    const writable: Record<string, unknown> = step;
    const timeFraction = source.timeFraction + (part.start - rect.start) / Math.max(1e-9, source.secondsPerFraction);
    writable.sourceFile = { path: source.path };
    writable.sourcePositionMode = "fixed";
    writable.sourceTimeOffset = timeFraction * 100;
    writable.sourcePitchOffset = source.pitchFraction * 100;
    // The faithful warp, pinned: a paste is a translation, not a brush choice.
    writable.algorithm = NEUTRAL_ALGORITHM;
    return { state: withStep(state, step, { fileId, rect }), rect: part };
  });
}
