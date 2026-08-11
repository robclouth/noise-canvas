// Strudel ships no TypeScript declarations. These describe only the surface the
// generate engine touches, matching the runtime shape of @strudel/core 1.2.x.

declare module "@strudel/core" {
  /** A rational time value; valueOf() gives the number of cycles. */
  export interface Fraction {
    valueOf(): number;
  }

  export interface TimeSpan {
    begin: Fraction;
    end: Fraction;
  }

  export interface Hap {
    /** The event's own extent. Undefined for fragments with no onset. */
    whole?: TimeSpan;
    part: TimeSpan;
    value: unknown;
    hasOnset(): boolean;
  }

  export interface Pattern {
    queryArc(begin: number, end: number): Hap[];
    fast(factor: number): Pattern;
    slow(factor: number): Pattern;
    rev(): Pattern;
    palindrome(): Pattern;
    iter(n: number): Pattern;
    ply(n: number): Pattern;
    every(n: number, fn: (pattern: Pattern) => Pattern): Pattern;
    when(test: (cycle: number) => boolean, fn: (pattern: Pattern) => Pattern): Pattern;
    sometimesBy(amount: number, fn: (pattern: Pattern) => Pattern): Pattern;
    sometimes(fn: (pattern: Pattern) => Pattern): Pattern;
    degradeBy(amount: number): Pattern;
    undegradeBy(amount: number): Pattern;
    segment(n: number): Pattern;
    euclid(pulses: number, steps: number): Pattern;
    euclidRot(pulses: number, steps: number, rotation: number): Pattern;
    off(offset: number, fn: (pattern: Pattern) => Pattern): Pattern;
    superimpose(fn: (pattern: Pattern) => Pattern): Pattern;
    jux(fn: (pattern: Pattern) => Pattern): Pattern;
    early(cycles: number): Pattern;
    late(cycles: number): Pattern;
    chunk(n: number, fn: (pattern: Pattern) => Pattern): Pattern;
    shuffle(n: number): Pattern;
    scramble(n: number): Pattern;
    /** Sets the `n` field of each event's value (used here as a pitch offset). */
    n(value: unknown): Pattern;
    /** Sets the `s` field of each event's value (used here as the brush token). */
    s(value: unknown): Pattern;
    note(value: unknown): Pattern;
    gain(value: unknown): Pattern;
    pan(value: unknown): Pattern;
    /** Registered by createParams(); brush pitch size in semitones. */
    height(value: unknown): Pattern;
    /** Registered by createParams(); brush time size in beats. */
    width(value: unknown): Pattern;
    /** Registered by createParams(); which slice of the spectrum to stamp. */
    zone(value: unknown): Pattern;
    /** Registered by createParams(); how many slices the spectrum is cut into. */
    zones(value: unknown): Pattern;
    m1(value: unknown): Pattern;
    m2(value: unknown): Pattern;
    m3(value: unknown): Pattern;
    m4(value: unknown): Pattern;
  }

  export function isPattern(value: unknown): boolean | undefined;
  export function pure(value: unknown): Pattern;
  export function stack(...patterns: unknown[]): Pattern;
  export function cat(...patterns: unknown[]): Pattern;
  export function slowcat(...patterns: unknown[]): Pattern;
  export function fastcat(...patterns: unknown[]): Pattern;
  export function seq(...patterns: unknown[]): Pattern;
  export function sequence(...patterns: unknown[]): Pattern;
  export function polymeter(...patterns: unknown[]): Pattern;
  export function polyrhythm(...patterns: unknown[]): Pattern;
  export function randcat(...patterns: unknown[]): Pattern;
  export function run(n: unknown): Pattern;
  export function irand(n: unknown): Pattern;
  export function n(value: unknown): Pattern;
  export function s(value: unknown): Pattern;
  export function note(value: unknown): Pattern;
  export function gain(value: unknown): Pattern;
  export function pan(value: unknown): Pattern;
  /** Registers controls by name, returning them and adding them as Pattern methods. */
  export function createParams(...names: string[]): Record<string, (value: unknown) => Pattern>;
  /** Parses a note name ("c4", "a#3") into a MIDI note number. */
  export function noteToMidi(note: string): number;
  export const silence: Pattern;
  export const rand: Pattern;
  export const perlin: Pattern;
  export const saw: Pattern;
  export const isaw: Pattern;
  export const sine: Pattern;
  export const square: Pattern;
  export const tri: Pattern;
}

declare module "@strudel/mini" {
  import type { Pattern } from "@strudel/core";
  export function mini(...codes: string[]): Pattern;
  /** Makes every string argument to a strudel function parse as mini-notation. */
  export function miniAllStrings(): void;
}
