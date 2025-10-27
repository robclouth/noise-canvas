import { PresetType } from "./preset-schema";

export const factoryPresets: PresetType[] = [
  {
    id: "init",
    name: "Init",
    isFactory: true,
    version: 1,
    parameters: {},
  },
  {
    id: "stereo-widening",
    name: "Stereo Widening",
    isFactory: true,
    version: 1,
    parameters: {
      brushPanMod1Amount: 100,
      modulator1PatternRateBeats: 4,
    },
  },
];
