// createBrushSlice.ts
import { BEAT_VALUES, PITCH_VALUES_NO_FRACTIONS, WRAP_MODES } from "../lib/constants";
import type { BrushState, ZustandGet, ZustandSet } from "./types";
import { makeCreateParameter } from "./utils";

export const createBrushSlice = (set: ZustandSet, get: ZustandGet): BrushState => {
  const param = makeCreateParameter<BrushState>(set, get);

  return {
    ...param("brushWidthBeats", {
      kind: "number",
      name: "Brush Width",
      label: "Width",
      description: "The width of the brush in beats.",
      value: 1,
      min: 1 / 64,
      max: 32,
      unit: " b",
      scale: "log",
      rightValue: { value: 0, label: "Full" },
      marks: [...BEAT_VALUES, { value: 0, label: "Full" }],
    }),

    ...param("brushHeightSemis", {
      kind: "number",
      name: "Brush Height",
      label: "Height",
      description: "The height of the brush in semitones.",
      value: 12,
      min: 1,
      max: 96,
      step: 1,
      unit: " st",
      rightValue: { value: 0, label: "Full" },
      marks: [...PITCH_VALUES_NO_FRACTIONS, { value: 0, label: "Full" }],
    }),

    ...param("brushSizeLockedToGrid", {
      kind: "boolean",
      name: "Lock Brush Size to Grid",
      label: "Lock size",
      description: "Locks the brush size to the grid size.",
      value: false,
    }),

    ...param("brushWrapMode", {
      kind: "options",
      name: "Wrap Mode",
      label: "Wrap",
      description: "Controls whether the brush wraps around the edges of the canvas.",
      value: 0,
      options: WRAP_MODES,
    }),

    ...param(
      "brushIntensity",
      {
        kind: "number",
        name: "Brush Strength",
        label: "Strength",
        description: "Controls the strength of the brush.",
        value: 100,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      },
      { modulatable: true },
    ),

    ...param("brushIterations", {
      kind: "number",
      name: "Brush Iterations",
      label: "Iterations",
      description: "How many times to apply the brush effect.",
      value: 1,
      min: 1,
      max: 20,
      step: 1,
    }),

    ...param(
      "brushPan",
      {
        kind: "number",
        name: "Pan",
        label: "Pan",
        description: "Pans the brush effect left or right.",
        value: 0,
        min: -100,
        max: 100,
        step: 1,
        unit: "%",
      },
      { modulatable: true },
    ),

    ...param("brushFeatherTime", {
      kind: "number",
      name: "Feather Time",
      label: "Feather H",
      description: "Softens the brush effect at the edges of the time selection.",
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
    }),

    ...param("brushFeatherPitch", {
      kind: "number",
      name: "Feather Pitch",
      label: "Feather V",
      description: "Softens the brush effect at the edges of the pitch selection.",
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
    }),

    ...param("brushFeatherSlopeTime", {
      kind: "number",
      name: "Feather Slope Time",
      label: "Slope H",
      description:
        "Controls the slope of the time feathering. -100 is fast initial rise, long tail, 100 is slow attack, fast finish.",
      value: 0,
      min: -100,
      max: 100,
      step: 1,
      unit: "%",
    }),

    ...param("brushFeatherSlopePitch", {
      kind: "number",
      name: "Feather Slope Pitch",
      label: "Slope V",
      description:
        "Controls the slope of the pitch feathering. -100 is fast initial rise, long tail, 100 is slow attack, fast finish.",
      value: 0,
      min: -100,
      max: 100,
      step: 1,
      unit: "%",
    }),

    ...param("sourcePositionMode", {
      kind: "options",
      name: "Source Position Mode",
      label: "Mode",
      description: "How the source position is used when painting.",
      value: "anchored" as const,
      options: [
        { value: "fixed", label: "Fixed" },
        { value: "anchored", label: "Anchored" },
        { value: "offset", label: "Offset" },
      ],
    }),

    sourcePosition: null,
    setSourcePosition: (position) => set({ sourcePosition: position, lockedOffset: null }),
    isSettingPosition: false,
    setIsSettingPosition: (value: boolean) => set({ isSettingPosition: value }),
    brushStartPosition: null,
    setBrushStartPosition: (position) => set({ brushStartPosition: position }),
    lockedOffset: null,
    setLockedOffset: (offset) => set({ lockedOffset: offset }),
  };
};
