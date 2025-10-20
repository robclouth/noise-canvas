import { BEAT_VALUES, MODULATOR_MODES, NUM_MODULATORS, PATTERN_SHAPES, PITCH_VALUES } from "../lib/constants";
import type { ModulatorsState, ZustandSet } from "./types";
import { createParameterInternal } from "./utils";

function createModulatorParams(set: ZustandSet): ModulatorsState {
  let params = {} as any;
  for (let i = 0; i < NUM_MODULATORS; i++) {
    let paramKey = `modulator${i + 1}Mode`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Mode ${i + 1}`,
          label: "Mode",
          description: "The mode of the modulator.",
          value: 0,
          options: MODULATOR_MODES,
        },
        false,
      ),
    };
    paramKey = `modulator${i + 1}PatternShape`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Pattern Shape ${i + 1}`,
          label: "Shape",
          description: "The shape of the modulator pattern.",
          value: 0,
          options: PATTERN_SHAPES,
        },
        false,
      ),
    };
    paramKey = `modulator${i + 1}Strength`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Depth ${i + 1}`,
          label: "Depth",
          description: "The depth of the modulator.",
          value: 100,
          min: -100,
          max: 100,
          step: 1,
          unit: "%",
        },
        true,
      ),
    };
    paramKey = `modulator${i + 1}PatternRateBeats`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Pattern Rate Beats ${i + 1}`,
          label: "Rate H",
          description: "The rate of the modulator pattern.",
          value: 1,
          values: [{ value: 0, label: "Off" }, ...BEAT_VALUES].map((value) => ({
            value: value.value,
            label: value.label,
          })),
        },
        true,
      ),
    };
    paramKey = `modulator${i + 1}PatternRateSemis`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Pattern Rate Semis ${i + 1}`,
          label: "Rate V",
          description: "The rate of the modulator pattern.",
          value: 12,
          values: [{ value: 0, label: "Off" }, ...PITCH_VALUES].map((value) => ({
            value: value.value,
            label: value.label,
          })),
        },
        true,
      ),
    };
    paramKey = `modulator${i + 1}Rotation`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Rotation ${i + 1}`,
          label: "Rotation",
          description: "The rotation of the modulator pattern.",
          value: 0,
          min: 0,
          max: 360,
          step: 1,
          unit: "°",
        },
        true,
      ),
    };
    // Add image path as plain string (not a parameter)
    const imagePathKey = `modulator${i + 1}ImagePath`;
    const setterKey = `setModulator${i + 1}ImagePath`;
    params = {
      ...params,
      [imagePathKey]: "",
      [setterKey]: (path: string) => set({ [imagePathKey]: path }),
    };
    paramKey = `modulator${i + 1}PhaseMode`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Phase Mode ${i + 1}`,
          label: "Phase",
          description: "Whether the phase is anchored to the canvas or the brush position.",
          value: 0,
          options: [
            { value: 0, label: "Canvas" },
            { value: 1, label: "Brush" },
          ],
        },
        false,
      ),
    };
    paramKey = `modulator${i + 1}EnvelopeMinDb`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Envelope Min ${i + 1}`,
          label: "Min dB",
          description: "The minimum gain in dB for the envelope follower.",
          value: -60,
          min: -120,
          max: 0,
          step: 1,
          unit: "dB",
        },
        true,
      ),
    };
    paramKey = `modulator${i + 1}EnvelopeMaxDb`;
    params = {
      ...params,
      ...createParameterInternal(
        set,
        paramKey,
        {
          name: `Modulator Envelope Max ${i + 1}`,
          label: "Max dB",
          description: "The maximum gain in dB for the envelope follower.",
          value: 0,
          min: -120,
          max: 0,
          step: 1,
          unit: "dB",
        },
        true,
      ),
    };
  }
  return params;
}

export const createModulatorsSlice = (set: ZustandSet): ModulatorsState => ({
  ...createModulatorParams(set),
});
