import { effects, EffectType } from "@renderer/effects";
import { PresetType } from "./preset-schema";

const DEFAULT_EFFECT_ORDER = Object.keys(effects)
  .filter((key) => key !== "passthrough")
  .map((k) => ({ effect: k as EffectType, enabled: false }));

export const factoryPresets: PresetType[] = [
  {
    id: "init",
    name: "Init",
    isFactory: true,
    version: 1,
    parameters: {},
  },
  {
    id: "eraser",
    name: "Eraser",
    isFactory: true,
    version: 1,
    parameters: {
      effectOrder: [
        { effect: "dynamics", enabled: true },
        ...DEFAULT_EFFECT_ORDER.filter(({ effect }) => effect !== "dynamics"),
      ],
      dynamicsGainDb: -80,
    },
  },
  {
    id: "booster",
    name: "Booster",
    isFactory: true,
    version: 1,
    parameters: {
      effectOrder: [
        { effect: "dynamics", enabled: true },
        ...DEFAULT_EFFECT_ORDER.filter(({ effect }) => effect !== "dynamics"),
      ],
      dynamicsGainDb: 6,
    },
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
