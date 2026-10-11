import { getParameterDef } from "@renderer/parameters";
import type { RawRead, RawSampleFormat, RawStereo } from "../lib/raw-file";

/** The Open Raw dialog's settings. A `rawBytes` of 0 reads as much as fits; a `rawRemoveNoise` of 0 is off. */
export interface OpenRawSettings {
  rawBytes: number;
  rawFormat: RawSampleFormat;
  rawStereo: RawStereo;
  rawRead: RawRead;
  rawHoldLength: number;
  rawSpeed: number;
  rawRemoveNoise: number;
}

/** Every Open Raw setting at its parameter default. */
export function openRawDefaults(): OpenRawSettings {
  return {
    rawBytes: getParameterDef("rawBytes").default,
    rawFormat: getParameterDef("rawFormat").default,
    rawStereo: getParameterDef("rawStereo").default,
    rawRead: getParameterDef("rawRead").default,
    rawHoldLength: getParameterDef("rawHoldLength").default,
    rawSpeed: getParameterDef("rawSpeed").default,
    rawRemoveNoise: getParameterDef("rawRemoveNoise").default,
  };
}

export const createOpenRawSlice = (): OpenRawSettings => openRawDefaults();

const OPTION_KEYS = ["rawFormat", "rawStereo", "rawRead"] as const;

/** The default for each choice in `settings` the parameters no longer offer, such as one a saved session holds. */
export function knownOpenRawChoices(
  settings: Partial<Record<(typeof OPTION_KEYS)[number], unknown>>,
): Partial<OpenRawSettings> {
  const reset: Partial<OpenRawSettings> = {};
  for (const key of OPTION_KEYS) {
    const def = getParameterDef(key);
    if (def.kind === "options" && !def.options.some((option) => option.value === settings[key])) {
      Object.assign(reset, { [key]: def.default });
    }
  }
  return reset;
}
