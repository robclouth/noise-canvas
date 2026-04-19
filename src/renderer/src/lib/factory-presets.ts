import { CURRENT_PRESET_VERSION, PresetType } from "./preset-schema";

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
        effects: [],
      },
    ],
    linkedParams: [],
    macroNames: ["Macro 1", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [50, 50, 50, 50],
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
        effects: [{ id: "eraser-dynamics", effect: "dynamics", enabled: true, params: { dynamicsGainDb: -80 } }],
      },
    ],
    linkedParams: [],
    macroNames: ["Macro 1", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [50, 50, 50, 50],
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
        effects: [{ id: "booster-dynamics", effect: "dynamics", enabled: true, params: { dynamicsGainDb: 6 } }],
      },
    ],
    linkedParams: [],
    macroNames: ["Macro 1", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [50, 50, 50, 50],
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
        effects: [],
        sourceDataMode: "original",
        blendMode: 0, // Replace blend mode
      },
    ],
    linkedParams: [],
    macroNames: ["Macro 1", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [50, 50, 50, 50],
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
        effects: [],
        brushPanMod1Amount: 100,
        modulator1PatternRateBeats: 4,
      },
    ],
    linkedParams: [],
    macroNames: ["Macro 1", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [50, 50, 50, 50],
  },
];
