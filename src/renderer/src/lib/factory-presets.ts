import { effects, EffectType } from "@renderer/effects";
import { CURRENT_PRESET_VERSION, PresetType } from "./preset-schema";

const DEFAULT_EFFECT_ORDER = Object.keys(effects)
  .filter((key) => key !== "passthrough")
  .map((k) => ({ effect: k as EffectType, enabled: false }));

export const factoryPresets: PresetType[] = [
  {
    id: "init",
    name: "Init",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "init-step-1",
        name: "Step 1",
      },
    ],
    linkedParams: [],
  },
  {
    id: "eraser",
    name: "Eraser",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "eraser-step-1",
        name: "Step 1",
        effectOrder: [
          { effect: "dynamics", enabled: true },
          ...DEFAULT_EFFECT_ORDER.filter(({ effect }) => effect !== "dynamics"),
        ],
        dynamicsGainDb: -80,
      },
    ],
    linkedParams: [],
  },
  {
    id: "booster",
    name: "Booster",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "booster-step-1",
        name: "Step 1",
        effectOrder: [
          { effect: "dynamics", enabled: true },
          ...DEFAULT_EFFECT_ORDER.filter(({ effect }) => effect !== "dynamics"),
        ],
        dynamicsGainDb: 6,
      },
    ],
    linkedParams: [],
  },
  {
    id: "restore",
    name: "Restore",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "restore-step-1",
        name: "Step 1",
        sourceDataMode: "original",
        blendMode: 0, // Replace blend mode
      },
    ],
    linkedParams: [],
  },
  {
    id: "stereo-widening",
    name: "Stereo Widening",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "stereo-widening-step-1",
        name: "Step 1",
        brushPanMod1Amount: 100,
        modulator1PatternRateBeats: 4,
      },
    ],
    linkedParams: [],
  },
];
