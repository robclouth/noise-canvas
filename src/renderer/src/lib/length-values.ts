import type { DialogSettings } from "../store/dialog-settings";

/** What a dialog measures a length in. */
export type LengthUnit = "beats" | "seconds";

/** A length a dialog collects, in beats or in seconds. */
export type LengthValues = { length: number; unit: LengthUnit };

/** `values` in seconds, reading beats against `bpm`. */
export function lengthToSeconds(values: LengthValues, bpm: number): number {
  return values.unit === "beats" ? (60 / bpm) * values.length : values.length;
}

/** `seconds` in `unit`, the inverse of `lengthToSeconds`. */
export function secondsToLength(seconds: number, unit: LengthValues["unit"], bpm: number): number {
  return unit === "beats" ? (seconds * bpm) / 60 : seconds;
}

/** The three parameters a length dialog keeps: its unit and a length in each unit. */
export const SILENCE_LENGTH_KEYS = { unit: "silenceUnit", beats: "silenceBeats", seconds: "silenceSeconds" } as const;
export const FILE_LENGTH_KEYS = {
  unit: "fileLengthUnit",
  beats: "fileLengthBeats",
  seconds: "fileLengthSeconds",
} as const;
export type LengthKeys = typeof SILENCE_LENGTH_KEYS | typeof FILE_LENGTH_KEYS;

/** The length `keys` hold in `settings`, in the unit they pick. */
export function lengthValues(settings: DialogSettings, keys: LengthKeys): LengthValues {
  const unit = settings[keys.unit];
  return { unit, length: unit === "beats" ? settings[keys.beats] : settings[keys.seconds] };
}
