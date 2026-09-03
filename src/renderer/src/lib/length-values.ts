/** A length a dialog collects, in beats or in seconds. */
export type LengthValues = { length: number; unit: "beats" | "seconds" };

/** `values` in seconds, reading beats against `bpm`. */
export function lengthToSeconds(values: LengthValues, bpm: number): number {
  return values.unit === "beats" ? (60 / bpm) * values.length : values.length;
}

/** `seconds` in `unit`, the inverse of `lengthToSeconds`. */
export function secondsToLength(seconds: number, unit: LengthValues["unit"], bpm: number): number {
  return unit === "beats" ? (seconds * bpm) / 60 : seconds;
}
