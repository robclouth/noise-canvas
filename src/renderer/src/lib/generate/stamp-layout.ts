import { aimUvToBrushBlUv } from "@renderer/lib/brush-anchor";
import { freqToMidi } from "@renderer/lib/pitch-utils";
import { resolveBrushFootprint, unitsToUv } from "@renderer/lib/utils";
import type { BrushColor, SpectrogramData, State } from "@renderer/store/types";
import { BEATS_PER_CYCLE, evaluatePattern, queryStamps, type StampEvent } from "./pattern-engine";
import { resolveBrushToken } from "./resolve-brush";
import { buildStampState, type ResolvedStamp } from "./stamp-state";
import { inferZoneCount, zoneSlice } from "./zones";

/** One control the pattern set on a stamp, named as it was written. */
export interface StampLabel {
  name: string;
  value: string;
}

/**
 * Where one stamp lands and what the pattern asked of it. The painter turns
 * these into strokes and the canvas overlay draws them, so what is shown and
 * what is painted are resolved once rather than derived twice.
 */
export interface StampMarker {
  /** Brush origin and footprint in pitch UV: y runs up from the lowest band. */
  blX: number;
  blY: number;
  sizeX: number;
  sizeY: number;
  brushIndex: number;
  brushName: string;
  color: BrushColor;
  labels: StampLabel[];
}

export interface StampLayout extends StampMarker {
  /** The per-stamp state snapshot the stroke is painted from. */
  state: State;
}

/** Drops the state snapshot, leaving what the canvas overlay draws. */
export function toMarker(layout: StampLayout): StampMarker {
  const { blX, blY, sizeX, sizeY, brushIndex, brushName, color, labels } = layout;
  return { blX, blY, sizeX, sizeY, brushIndex, brushName, color, labels };
}

/** Trims a pattern value to the shortest form that still reads exactly. */
function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function labelsFor(event: StampEvent, zoneCount: number): StampLabel[] {
  const labels: StampLabel[] = [];
  if (event.zoneIndex !== undefined) {
    labels.push({ name: "zone", value: `${formatValue(event.zoneIndex)}/${event.zoneCount ?? zoneCount}` });
  }
  if (event.noteMidi !== undefined) labels.push({ name: "note", value: formatValue(event.noteMidi) });
  if (event.semis !== 0) labels.push({ name: "n", value: formatValue(event.semis) });
  if (event.gain !== undefined) labels.push({ name: "gain", value: formatValue(event.gain) });
  if (event.pan !== undefined) labels.push({ name: "pan", value: formatValue(event.pan) });
  if (event.widthBeats !== undefined) labels.push({ name: "width", value: formatValue(event.widthBeats) });
  if (event.heightSemis !== undefined) labels.push({ name: "height", value: formatValue(event.heightSemis) });
  event.macros?.forEach((macro, index) => {
    if (macro !== undefined) labels.push({ name: `m${index + 1}`, value: formatValue(macro) });
  });
  return labels;
}

export interface StampTarget {
  spectrogramData: SpectrogramData;
  bpm: number;
  totalDuration: number;
  /** Pitch a stamp takes when the pattern names none, in semitones above the lowest band. */
  basePitch: number;
}

/**
 * Runs the pattern over the file and places every stamp it produces. Throws the
 * pattern's own error when the code doesn't parse.
 */
export function resolveStampLayout(state: State, target: StampTarget): StampLayout[] {
  const { spectrogramData, bpm, totalDuration, basePitch } = target;
  const { bandsPerOctave, numBands } = spectrogramData;

  const fileBeats = (totalDuration / 60) * bpm;
  const cycles = Math.max(1, Math.ceil(fileBeats / BEATS_PER_CYCLE));
  const events = queryStamps(evaluatePattern(state.generateCode), cycles, state.generateSeed);

  // `note` names an absolute pitch; the app measures pitch in semitones above
  // the file's lowest band.
  const lowestMidi = freqToMidi(spectrogramData.minFreq);
  const spectrumSemis = (numBands / bandsPerOctave) * 12;
  const defaultZoneCount = inferZoneCount(events);

  const layouts: StampLayout[] = [];
  for (const event of events) {
    if (event.beats >= fileBeats) continue;

    const slice =
      event.zoneIndex !== undefined
        ? zoneSlice(event.zoneIndex, event.zoneCount ?? defaultZoneCount, spectrumSemis)
        : null;
    const anchorPitch = slice
      ? slice.anchorSemis
      : event.noteMidi !== undefined
        ? event.noteMidi - lowestMidi
        : basePitch;

    const brushIndex = resolveBrushToken(event.brushToken, state.brushes) ?? state.activeBrushIndex;
    const resolved: ResolvedStamp = {
      ...event,
      brushIndex,
      pitchSemis: anchorPitch + event.semis,
      sliceSemis: slice?.heightSemis,
    };
    const stampState = buildStampState(state, resolved);
    const brush = stampState.brushes[brushIndex];
    if (!brush) continue;

    const aim = unitsToUv(resolved.beats, resolved.pitchSemis, bpm, totalDuration, bandsPerOctave, numBands);
    // Anchor conversion reads the stamp's own brush size and anchor mode.
    const { blX, blY } = aimUvToBrushBlUv(stampState, aim.x, aim.y, bpm, totalDuration, bandsPerOctave, numBands);

    const step = brush.steps[stampState.activeStepIndex] as Record<string, unknown> | undefined;
    const footprint = resolveBrushFootprint({
      brushSizeTime: (step?.brushSizeTime as number | undefined) ?? stampState.brushSizeTime,
      brushSizePitch: (step?.brushSizePitch as number | undefined) ?? stampState.brushSizePitch,
      gridSizeBeats: stampState.gridSizeBeats,
      gridSizeSemis: stampState.gridSizeSemis,
      bpm,
      totalDuration,
      bandsPerOctave,
      numBands,
    });

    layouts.push({
      blX,
      blY,
      sizeX: footprint.sizeUv.x,
      sizeY: footprint.sizeUv.y,
      brushIndex,
      brushName: brush.name,
      color: brush.color,
      labels: labelsFor(event, defaultZoneCount),
      state: stampState,
    });
  }

  return layouts;
}
