import {
  cat,
  createParams,
  fastcat,
  gain,
  irand,
  isaw,
  n,
  note,
  noteToMidi,
  pan,
  perlin,
  polymeter,
  polyrhythm,
  pure,
  rand,
  randcat,
  run,
  s,
  saw,
  seq,
  sequence,
  silence,
  sine,
  slowcat,
  square,
  stack,
  tri,
  type Hap,
  type Pattern,
} from "@strudel/core";
import { mini, miniAllStrings } from "@strudel/mini";

/** One strudel cycle spans this many beats of the file. */
export const BEATS_PER_CYCLE = 4;

/** Patterns denser than this are rejected rather than stamped. */
export const MAX_STAMPS = 1024;

/** Cycles between the query windows of consecutive seeds. */
const SEED_WINDOW_CYCLES = 1024;

/** Number of macros a brush carries. */
export const MACRO_COUNT = 4;

/** Controls the app registers with strudel on top of the built-in ones. */
export const CUSTOM_CONTROLS = ["width", "height", "zone", "zones", "m1", "m2", "m3", "m4"] as const;

export interface StampEvent {
  /** Onset in beats from the start of the file. */
  beats: number;
  /** Event length in beats. */
  durationBeats: number;
  /** Raw token naming the brush ("1", "b", "kick"); "" when the event carries none. */
  brushToken: string;
  /** Semitone offset from the base pitch, from `n`. */
  semis: number;
  /** Absolute pitch as a MIDI note number, from `note`. */
  noteMidi?: number;
  /** Multiplier on the brush's strength, from `gain`. */
  gain?: number;
  /** Stereo position from -1 (left) to 1 (right), from `pan`. */
  pan?: number;
  /** Brush time size in beats, from `width`; overrides the event's length. */
  widthBeats?: number;
  /** Brush pitch size in semitones, from `height`. */
  heightSemis?: number;
  /** Which slice of the spectrum to stamp, counting up from the lowest, from `zone`. */
  zoneIndex?: number;
  /** How many slices the spectrum is cut into, from `zones`. */
  zoneCount?: number;
  /** Macro values 0–1 from `m1`–`m4`; undefined entries keep the brush's own. */
  macros?: (number | undefined)[];
}

let stringParserInstalled = false;
let customControls: Record<string, (value: unknown) => Pattern> = {};

function ensureInit(): void {
  if (stringParserInstalled) return;
  miniAllStrings();
  customControls = createParams(...CUSTOM_CONTROLS);
  stringParserInstalled = true;
}

/** Functions and signals a pattern expression may reference. */
function buildScope(): Record<string, unknown> {
  return {
    mini,
    pure,
    stack,
    cat,
    slowcat,
    fastcat,
    seq,
    sequence,
    polymeter,
    polyrhythm,
    randcat,
    run,
    irand,
    n,
    s,
    note,
    gain,
    pan,
    silence,
    rand,
    perlin,
    saw,
    isaw,
    sine,
    square,
    tri,
    ...customControls,
  };
}

function hasQueryArc(value: unknown): value is Pattern {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { queryArc?: unknown }).queryArc === "function";
}

/**
 * Evaluates pattern source into a Pattern. A bare mini-notation string such as
 * `"x*8"` evaluates to a string and is parsed as mini-notation; anything else
 * must produce a Pattern.
 */
export function evaluatePattern(code: string): Pattern {
  ensureInit();
  const source = code.trim();
  if (source === "") throw new Error("Empty pattern");

  const scope = buildScope();
  const names = Object.keys(scope);
  const values = names.map((key) => scope[key]);

  let result: unknown;
  try {
    const evaluate = new Function(...names, `"use strict"; return (${source});`) as (...args: unknown[]) => unknown;
    result = evaluate(...values);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  if (typeof result === "string") return mini(result);
  if (hasQueryArc(result)) return result;
  throw new Error("Pattern expected");
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Note names and MIDI numbers both name an absolute pitch. */
function readNote(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  try {
    const midi = noteToMidi(value);
    return Number.isFinite(midi) ? midi : undefined;
  } catch {
    return undefined;
  }
}

function readMacros(record: Record<string, unknown>): (number | undefined)[] | undefined {
  let found = false;
  const macros: (number | undefined)[] = [];
  for (let i = 0; i < MACRO_COUNT; i++) {
    const value = readNumber(record[`m${i + 1}`]);
    macros.push(value);
    if (value !== undefined) found = true;
  }
  return found ? macros : undefined;
}

function readValue(value: unknown): Omit<StampEvent, "beats" | "durationBeats"> {
  if (typeof value === "string" || typeof value === "number") {
    return { brushToken: String(value), semis: 0 };
  }
  if (typeof value !== "object" || value === null) {
    return { brushToken: "", semis: 0 };
  }

  const record = value as Record<string, unknown>;
  const token = record.s;
  return {
    brushToken: typeof token === "string" || typeof token === "number" ? String(token) : "",
    semis: readNumber(record.n) ?? 0,
    noteMidi: readNote(record.note),
    gain: readNumber(record.gain),
    // Strudel pans 0 (left) to 1 (right); the app's pan is centred on zero.
    pan: record.pan === undefined ? undefined : (readNumber(record.pan) ?? 0.5) * 2 - 1,
    widthBeats: readNumber(record.width),
    heightSemis: readNumber(record.height),
    zoneIndex: readNumber(record.zone),
    zoneCount: readNumber(record.zones),
    macros: readMacros(record),
  };
}

function toStamp(hap: Hap, offsetCycles: number): StampEvent | null {
  const { whole } = hap;
  if (!whole) return null;
  const begin = whole.begin.valueOf() - offsetCycles;
  const end = whole.end.valueOf() - offsetCycles;
  return {
    ...readValue(hap.value),
    beats: begin * BEATS_PER_CYCLE,
    durationBeats: (end - begin) * BEATS_PER_CYCLE,
  };
}

/**
 * Queries a pattern over `cycles` cycles and returns one stamp per event onset.
 * The seed picks the window queried: strudel's randomness is a hash of time, so
 * a far-off window gives independent results, and an even cycle offset leaves
 * alternations (`<a b>`) starting on their first value.
 */
export function queryStamps(pattern: Pattern, cycles: number, seed: number): StampEvent[] {
  const spanCycles = Math.max(1, Math.ceil(cycles));
  const offsetCycles = seed * SEED_WINDOW_CYCLES;
  const haps = pattern.queryArc(offsetCycles, offsetCycles + spanCycles);

  const stamps: StampEvent[] = [];
  for (const hap of haps) {
    if (!hap.hasOnset()) continue;
    const stamp = toStamp(hap, offsetCycles);
    if (stamp) stamps.push(stamp);
  }
  if (stamps.length > MAX_STAMPS) {
    throw new Error(`Pattern too dense (${stamps.length} events, limit ${MAX_STAMPS})`);
  }
  stamps.sort((a, b) => a.beats - b.beats);
  return stamps;
}
