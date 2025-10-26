import { parameterDefs } from "@renderer/parameters";
import { NUM_MODULATORS } from "../lib/constants";
import type { ZustandGet, ZustandSet } from "./types";

export type ModulatorsState = any;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createModulatorParams(set: ZustandSet, get: ZustandGet): any {
  const params: Record<string, any> = {};

  for (let i = 0; i < NUM_MODULATORS; i++) {
    const idx = i + 1;

    {
      const key = `modulator${idx}Mode` as keyof ModulatorsState;
      params[key] = parameterDefs[key].default;
    }

    {
      const key = `modulator${idx}PatternShape` as keyof ModulatorsState;
      params[key] = parameterDefs[key].default;
    }

    {
      const key = `modulator${idx}Strength` as keyof ModulatorsState;
      params[key] = parameterDefs[key].default;
    }

    {
      const key = `modulator${idx}PatternRateBeats` as keyof ModulatorsState;
      params[key] = parameterDefs[key].default;
    }

    {
      const key = `modulator${idx}PatternRateSemis` as keyof ModulatorsState;
      params[key] = parameterDefs[key].default;
    }

    {
      const key = `modulator${idx}Rotation` as keyof ModulatorsState;
      params[key] = parameterDefs[key].default;
    }

    {
      const key = `modulator${idx}TexturePath` as keyof ModulatorsState;
      params[key] = parameterDefs[key].default;
    }

    {
      const key = `modulator${idx}PhaseMode` as keyof ModulatorsState;
      params[key] = parameterDefs[key].default;
    }

    {
      const key = `modulator${idx}EnvelopeMinDb` as keyof ModulatorsState;
      params[key] = parameterDefs[key].default;
    }

    {
      const key = `modulator${idx}EnvelopeMaxDb` as keyof ModulatorsState;
      params[key] = parameterDefs[key].default;
    }
  }

  return params;
}

export const createModulatorsSlice = (set: ZustandSet, get: ZustandGet): ModulatorsState => ({
  ...createModulatorParams(set, get),
});
