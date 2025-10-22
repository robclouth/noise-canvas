import {
  BEAT_UNIT,
  BEAT_VALUES,
  MODULATOR_MODES,
  NUM_MODULATORS,
  PATTERN_SHAPES,
  PITCH_VALUES,
  SEMITONE_UNIT,
} from "../lib/constants";
import type { ModulatorsState, ZustandGet, ZustandSet } from "./types";
import { makeCreateParameter } from "./utils";

// Small helpers to build marks
const beatMarksWithOff = [{ value: 0, label: "Off" }, ...BEAT_VALUES];
const semitoneMarksWithOff = [{ value: 0, label: "Off" }, ...PITCH_VALUES];

function createModulatorParams(set: ZustandSet, get: ZustandGet): ModulatorsState {
  const param = makeCreateParameter<ModulatorsState>(set, get);

  let params = {} as ModulatorsState;

  for (let i = 0; i < NUM_MODULATORS; i++) {
    const idx = i + 1;

    {
      const key = `modulator${idx}Mode` as keyof ModulatorsState;
      params = {
        ...params,
        ...param(key, {
          kind: "options",
          name: `Modulator Mode ${idx}`,
          label: "Mode",
          description: "The mode of the modulator.",
          value: 0,
          options: MODULATOR_MODES,
        }),
      };
    }

    {
      const key = `modulator${idx}PatternShape` as keyof ModulatorsState;
      params = {
        ...params,
        ...param(key, {
          kind: "options",
          name: `Modulator Pattern Shape ${idx}`,
          label: "Shape",
          description: "The shape of the modulator pattern.",
          value: 0,
          options: PATTERN_SHAPES,
        }),
      };
    }

    {
      const key = `modulator${idx}Strength` as keyof ModulatorsState;
      params = {
        ...params,
        ...param(
          key,
          {
            kind: "number",
            name: `Modulator Depth ${idx}`,
            label: "Depth",
            description: "The depth of the modulator.",
            value: 100,
            min: -100,
            max: 100,
            step: 1,
            unit: "%",
          },
          { modulatable: true },
        ),
      };
    }

    {
      const key = `modulator${idx}PatternRateBeats` as keyof ModulatorsState;
      params = {
        ...params,
        ...param(
          key,
          {
            kind: "number",
            name: `Modulator Pattern Rate Beats ${idx}`,
            label: "Rate H",
            description: "The rate of the modulator pattern (horizontal).",
            value: 1,
            min: 0,
            max: 32,
            step: 0.0001,
            marks: beatMarksWithOff,
            scale: "log",
            unit: BEAT_UNIT,
          },
          { modulatable: true },
        ),
      };
    }

    {
      const key = `modulator${idx}PatternRateSemis` as keyof ModulatorsState;
      params = {
        ...params,
        ...param(
          key,
          {
            kind: "number",
            name: `Modulator Pattern Rate Semis ${idx}`,
            label: "Rate V",
            description: "The rate of the modulator pattern (vertical).",
            value: 12,
            min: 0,
            max: 96,
            step: 1,
            marks: semitoneMarksWithOff,
            unit: SEMITONE_UNIT,
          },
          { modulatable: true },
        ),
      };
    }

    {
      const key = `modulator${idx}Rotation` as keyof ModulatorsState;
      params = {
        ...params,
        ...param(
          key,
          {
            kind: "number",
            name: `Modulator Rotation ${idx}`,
            label: "Rotation",
            description: "The rotation of the modulator pattern.",
            value: 0,
            min: 0,
            max: 360,
            step: 1,
            unit: "°",
          },
          { modulatable: true },
        ),
      };
    }

    {
      const imagePathKey = `modulator${idx}ImagePath` as keyof ModulatorsState;
      const setterKey = `setModulator${idx}ImagePath` as keyof ModulatorsState;

      params = {
        ...params,
        [imagePathKey]: "" as any, // state field (string)
        [setterKey]: ((path: string) => set({ [imagePathKey]: path } as any)) as any,
      };
    }

    {
      const key = `modulator${idx}PhaseMode` as keyof ModulatorsState;
      params = {
        ...params,
        ...param(key, {
          kind: "options",
          name: `Modulator Phase Mode ${idx}`,
          label: "Phase",
          description: "Whether the phase is anchored to the canvas or the brush position.",
          value: 0,
          options: [
            { value: 0, label: "Canvas" },
            { value: 1, label: "Brush" },
          ],
        }),
      };
    }

    {
      const key = `modulator${idx}EnvelopeMinDb` as keyof ModulatorsState;
      params = {
        ...params,
        ...param(
          key,
          {
            kind: "number",
            name: `Modulator Envelope Min ${idx}`,
            label: "Min dB",
            description: "The minimum gain in dB for the envelope follower.",
            value: -60,
            min: -120,
            max: 0,
            step: 1,
            unit: "dB",
          },
          { modulatable: true },
        ),
      };
    }

    {
      const key = `modulator${idx}EnvelopeMaxDb` as keyof ModulatorsState;
      params = {
        ...params,
        ...param(
          key,
          {
            kind: "number",
            name: `Modulator Envelope Max ${idx}`,
            label: "Max dB",
            description: "The maximum gain in dB for the envelope follower.",
            value: 0,
            min: -120,
            max: 0,
            step: 1,
            unit: "dB",
          },
          { modulatable: true },
        ),
      };
    }
  }

  return params;
}

export const createModulatorsSlice = (set: ZustandSet, get: ZustandGet): ModulatorsState => ({
  ...createModulatorParams(set, get),
});
