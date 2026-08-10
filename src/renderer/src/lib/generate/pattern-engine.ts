import {
  cat,
  fastcat,
  irand,
  isaw,
  n,
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

export interface StampEvent {
  /** Onset in beats from the start of the file. */
  beats: number;
  /** Event length in beats. */
  durationBeats: number;
  /** Raw token naming the brush ("1", "b", "kick"); "" when the event carries none. */
  brushToken: string;
  /** Semitone offset from the base pitch, from the event's `n` value. */
  semis: number;
}

let stringParserInstalled = false;

function ensureInit(): void {
  if (stringParserInstalled) return;
  miniAllStrings();
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
    silence,
    rand,
    perlin,
    saw,
    isaw,
    sine,
    square,
    tri,
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

function readValue(value: unknown): { brushToken: string; semis: number } {
  if (typeof value === "string" || typeof value === "number") {
    return { brushToken: String(value), semis: 0 };
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const token = record.s;
    const offset = record.n;
    return {
      brushToken: typeof token === "string" || typeof token === "number" ? String(token) : "",
      semis: typeof offset === "number" ? offset : 0,
    };
  }
  return { brushToken: "", semis: 0 };
}

function toStamp(hap: Hap, offsetCycles: number): StampEvent | null {
  const { whole } = hap;
  if (!whole) return null;
  const begin = whole.begin.valueOf() - offsetCycles;
  const end = whole.end.valueOf() - offsetCycles;
  const { brushToken, semis } = readValue(hap.value);
  return {
    beats: begin * BEATS_PER_CYCLE,
    durationBeats: (end - begin) * BEATS_PER_CYCLE,
    brushToken,
    semis,
  };
}

/**
 * Queries a pattern over `cycles` cycles and returns one stamp per event onset.
 *
 * Strudel's randomness is a deterministic hash of time, so re-querying the same
 * window always gives the same events. A seed therefore selects a different
 * window far enough along the timeline to be independent, keeping cycle parity
 * even so that non-random alternations (`<a b>`) still start on their first
 * value.
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
