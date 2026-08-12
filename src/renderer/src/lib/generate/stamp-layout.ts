import { freqToMidi } from "@renderer/lib/pitch-utils";
import { resolveBrushFootprint, unitsToUv } from "@renderer/lib/utils";
import type { BrushColor, SpectrogramData, State } from "@renderer/store/types";
import { BEATS_PER_CYCLE, evaluatePattern, queryStamps, type StampEvent } from "./pattern-engine";
import { resolveBrushToken } from "./resolve-brush";
import { buildStampState, stampSizes, type ResolvedStamp } from "./stamp-state";
import { inferZoneCount, zoneSlice } from "./zones";

/** One control the pattern set on a stamp, named as it was written. */
export interface StampLabel {
  name: string;
  value: string;
}

/**
 * Where one stamp lands and what the pattern asked of it — everything the
 * canvas overlay draws, and nothing that costs a state snapshot to work out.
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

/** A placed stamp, and the resolution the painter needs to build its state from. */
interface Placement {
  marker: StampMarker;
  resolved: ResolvedStamp;
}

function placeEvent(state: State, target: StampTarget, event: StampEvent, zoneCount: number): Placement | null {
  const { spectrogramData, bpm, totalDuration, basePitch } = target;
  const { bandsPerOctave, numBands } = spectrogramData;

  const spectrumSemis = (numBands / bandsPerOctave) * 12;
  const slice =
    event.zoneIndex !== undefined ? zoneSlice(event.zoneIndex, event.zoneCount ?? zoneCount, spectrumSemis) : null;
  // `note` names an absolute pitch; the app measures pitch in semitones above
  // the file's lowest band.
  const anchorPitch = slice
    ? slice.anchorSemis
    : event.noteMidi !== undefined
      ? event.noteMidi - freqToMidi(spectrogramData.minFreq)
      : basePitch;

  const brushIndex = resolveBrushToken(event.brushToken, state.brushes) ?? state.activeBrushIndex;
  const brush = state.brushes[brushIndex];
  if (!brush) return null;

  const resolved: ResolvedStamp = {
    ...event,
    brushIndex,
    pitchSemis: anchorPitch + event.semis,
    sliceSemis: slice?.heightSemis,
  };

  const step = brush.steps[state.activeStepIndex] as Record<string, unknown> | undefined;
  const sizes = stampSizes(resolved);
  const footprint = resolveBrushFootprint({
    brushSizeTime: sizes.sizeTime,
    brushSizePitch: sizes.sizePitch ?? (step?.brushSizePitch as number | undefined) ?? state.brushSizePitch,
    gridSizeBeats: state.gridSizeBeats,
    gridSizeSemis: state.gridSizeSemis,
    bpm,
    totalDuration,
    bandsPerOctave,
    numBands,
  });

  // Stamps are corner-anchored — buildStampState says so for every one — which
  // makes the aim point the brush origin, with no footprint to subtract.
  const aim = unitsToUv(resolved.beats, resolved.pitchSemis, bpm, totalDuration, bandsPerOctave, numBands);

  return {
    resolved,
    marker: {
      blX: aim.x,
      blY: aim.y,
      sizeX: footprint.sizeUv.x,
      sizeY: footprint.sizeUv.y,
      brushIndex,
      brushName: brush.name,
      color: brush.color,
      labels: labelsFor(event, zoneCount),
    },
  };
}

/** Runs the pattern over the file and places every stamp it produces. */
function placeAll(state: State, target: StampTarget): Placement[] {
  const fileBeats = (target.totalDuration / 60) * target.bpm;
  const cycles = Math.max(1, Math.ceil(fileBeats / BEATS_PER_CYCLE));
  const events = queryStamps(evaluatePattern(state.generateCode), cycles, state.generateSeed);
  const zoneCount = inferZoneCount(events);

  const placements: Placement[] = [];
  for (const event of events) {
    if (event.beats >= fileBeats) continue;
    const placement = placeEvent(state, target, event, zoneCount);
    if (placement) placements.push(placement);
  }
  return placements;
}

/**
 * Where the pass lands, without the state snapshots painting it needs. This is
 * the cheap path: the overlay runs it on every keystroke.
 */
export function resolveStampMarkers(state: State, target: StampTarget): StampMarker[] {
  return placeAll(state, target).map((placement) => placement.marker);
}

/**
 * The same pass, each stamp carrying the state its stroke is painted from.
 * Building those snapshots clones the store per stamp, so only the painter asks
 * for them.
 */
export function resolveStampLayout(state: State, target: StampTarget): StampLayout[] {
  return placeAll(state, target).map(({ marker, resolved }) => ({
    ...marker,
    state: buildStampState(state, resolved),
  }));
}
