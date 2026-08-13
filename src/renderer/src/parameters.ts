import { startCase } from "lodash-es";
import { ScaleType } from "tonal";
import { cloneShapes, CLONE_SHAPE_KEYS } from "./effects/clone-shapes";
import { DEFAULT_EFFECTS, EffectParams, EffectType } from "./effects/types";
import {
  ALGORITHMS,
  BANDS_PER_OCTAVE_VALUES,
  BEAT_UNIT,
  BEAT_VALUES,
  BLEND_MODES,
  BRUSH_ANCHOR_MODES,
  CONTEXTUAL_MOD_SOURCES,
  EDGE_MODE,
  NEUTRAL_ALGORITHM,
  MODULATOR_MODES,
  MULTIPLIER_UNIT,
  MULTIPLIER_VALUES,
  NUM_MACROS,
  NUM_MODULATORS,
  ONSETS_GRID_VALUE,
  PATTERN_SHAPES,
  PITCH_VALUES,
  PITCH_VALUES_NO_FRACTIONS,
  SEMITONE_UNIT,
  SYNTHESIZE_TYPES,
  WRAP_MODES,
} from "./lib/constants";
import { host } from "./lib/host";
import { BrushColor, ParameterKey } from "./store/types";

// --- Base Interfaces ---

/** File parameter value. Just the path — position is in separate modulatable params. */
export type FileParameterValue = { path: string } | null;

export interface ParameterBase {
  kind: "number" | "boolean" | "options" | "string" | "file";
  name: string;
  label: string;
  description: string;
  includeInStep?: boolean;
  effectType?: EffectType;
}

export interface NumberParameter extends ParameterBase {
  kind: "number";
  default: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  scale?: string;
  leftValue?: { value: number; label: string };
  rightValue?: { value: number; label: string };
  marks?: Array<{ value: number; label: string }>;
  modulatable?: boolean;
  modulationSourcesAllowed?: "all" | "contextualOnly";
}
export interface BooleanParameter extends ParameterBase {
  kind: "boolean";
  default: boolean;
}

export interface StringParameter extends ParameterBase {
  kind: "string";
  default: string;
}

export interface OptionsParameter<T = any> extends ParameterBase {
  kind: "options";
  default: T;
  options: { value: T; label: string }[];
}

export interface FileParameter extends ParameterBase {
  kind: "file";
  default: FileParameterValue;
  /**
   * How the user picks a file for this param.
   * - "canvas" — hijack clicks on open file canvases; the click position seeds companion
   *   offset params (time/pitch). Used by sourceFile for spatial sampling pick.
   * - "modal"  — open a list of currently-open files and pick by name. Companion offset
   *   params are controlled only via their sliders.
   */
  pickMode: "canvas" | "modal";
  /** Canvas-mode only: param to receive click x. */
  timeOffsetParam?: ParameterKey;
  /** Canvas-mode only: param to receive click y. */
  pitchOffsetParam?: ParameterKey;
  /** Canvas-mode only: what indicator to draw while picking. */
  previewMode?: "brushRect";
  /** Canvas-mode only: whether Shift-held activates the picker. */
  enableShortcut?: boolean;
}

export type ParameterDef = NumberParameter | BooleanParameter | OptionsParameter | StringParameter | FileParameter;

type ParameterDefInput = NumberParameter | BooleanParameter | OptionsParameter | StringParameter | FileParameter;

const negBeatMarks = BEAT_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const zeroBeatMark = { value: 0, label: "0" };
const posBeatMarks = BEAT_VALUES;
const negPitchMarks = PITCH_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const zeroPitchMark = { value: 0, label: "0" };
const posPitchMarks = PITCH_VALUES;
const negMultMarks = MULTIPLIER_VALUES.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse();
const posMultMarks = MULTIPLIER_VALUES;
const beatMarksWithOff = [{ value: 0, label: "Off" }, ...BEAT_VALUES];
const beatMarksWithZero = [{ value: 0, label: "0" }, ...BEAT_VALUES];
const semitoneMarksWithOff = [{ value: 0, label: "Off" }, ...PITCH_VALUES];

// --- Modulator Definitions ---
// Nested modulation (modulating modulator parameters) is disabled on Windows
// due to shader compilation performance issues with unrolled loops
const isWindows = typeof window !== "undefined" && host.env.platform === "win32";
const modulatorDefs: Record<string, ParameterDefInput> = {};
for (let i = 0; i < NUM_MODULATORS; i++) {
  const idx = i + 1;
  modulatorDefs[`modulator${idx}Mode`] = {
    kind: "options",
    name: `Modulator Mode ${idx}`,
    label: "Mode",
    description:
      "Chooses what drives this modulator: a scrolling 2D pattern, the painted region's own envelope, or a sequencer grid.",
    default: 0,
    options: MODULATOR_MODES,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}PatternShape`] = {
    kind: "options",
    name: `Modulator Pattern Shape ${idx}`,
    label: "Shape",
    description:
      "Picks the 2D field the pattern draws — a waveform, a procedural texture, the selected scale, or your own image.",
    default: 0,
    options: PATTERN_SHAPES,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}Strength`] = {
    kind: "number",
    name: `Modulator Depth ${idx}`,
    label: "Depth",
    description: "Scales how far the modulator swings. Negative flips it upside down.",
    default: 100,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}PatternRateBeats`] = {
    kind: "number",
    name: `Modulator Pattern Rate Beats ${idx}`,
    label: "Rate ↔",
    description:
      "Spans one cycle of the pattern over this many beats. Bigger is slower; at 0 the pattern stops varying along time.",
    default: 1,
    min: 0,
    max: 32,
    step: 0.0001,
    marks: beatMarksWithOff,
    scale: "log",
    unit: BEAT_UNIT,
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}PatternRateSemis`] = {
    kind: "number",
    name: `Modulator Pattern Rate Semis ${idx}`,
    label: "Rate ↕",
    description: "Spans one cycle of the pattern over this many semitones. At 0 the pattern stops varying along pitch.",
    default: 12,
    min: 0,
    max: 96,
    step: 1,
    marks: semitoneMarksWithOff,
    unit: SEMITONE_UNIT,
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}Rotation`] = {
    kind: "number",
    name: `Modulator Rotation ${idx}`,
    label: "Rotation",
    description: "Turns the pattern on the canvas, so it cuts diagonally across time and pitch.",
    default: 0,
    min: 0,
    max: 360,
    step: 1,
    unit: "°",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}StereoSpread`] = {
    kind: "number",
    name: `Modulator Stereo Spread ${idx}`,
    label: "Stereo",
    description:
      "Decorrelates the modulator's left and right outputs by offsetting the sample position along the time axis. Negative values swap channels.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}PhaseMode`] = {
    kind: "options",
    name: `Modulator Phase Mode ${idx}`,
    label: "Phase Mode",
    description:
      "Pins the pattern to the canvas, so separate strokes uncover one stationary field, or to the brush, so it travels with each stamp.",
    default: 0,
    options: [
      { value: 0, label: "Canvas" },
      { value: 1, label: "Brush" },
    ],
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}PhaseX`] = {
    kind: "number",
    name: `Modulator Phase X ${idx}`,
    label: "Phase ↔",
    description: "Slides the pattern along time without moving the brush.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}PhaseY`] = {
    kind: "number",
    name: `Modulator Phase Y ${idx}`,
    label: "Phase ↕",
    description: "Slides the pattern along pitch without moving the brush.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}EnvelopeSmoothingBeats`] = {
    kind: "number",
    name: `Modulator Envelope Smoothing ${idx}`,
    label: "Smooth",
    description: "Averages the envelope signal over this window of time to reduce fast transients.",
    default: 0,
    min: 0,
    max: 4,
    step: 0.01,
    unit: BEAT_UNIT,
    scale: "log",
    marks: beatMarksWithZero,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}EnvelopeSource`] = {
    kind: "options",
    name: `Modulator Envelope Source ${idx}`,
    label: "Source",
    description: "Follows the painted region's own amplitude, phase, or panning.",
    default: 0,
    options: [
      { value: 0, label: "Amplitude" },
      { value: 1, label: "Phase" },
      { value: 2, label: "Panning" },
    ],
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}EnvelopeMinDb`] = {
    kind: "number",
    name: `Modulator Envelope Min ${idx}`,
    label: "Min dB",
    description: "Sets the level the follower reads as fully off. Anything quieter contributes no modulation.",
    default: -60,
    min: -120,
    max: 0,
    step: 1,
    unit: "dB",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}EnvelopeMaxDb`] = {
    kind: "number",
    name: `Modulator Envelope Max ${idx}`,
    label: "Max dB",
    description: "Sets the level the follower reads as fully on. Anything louder is clamped to it.",
    default: 0,
    min: -120,
    max: 0,
    step: 1,
    unit: "dB",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}TexturePath`] = {
    kind: "string",
    name: `Modulator Texture Path ${idx}`,
    label: "Texture",
    description: "Points at the image the pattern is read from.",
    default: "",
    includeInStep: true,
  };
  // Sequencer mode parameters
  modulatorDefs[`modulator${idx}SeqStepsX`] = {
    kind: "number",
    name: `Sequencer Steps X ${idx}`,
    label: "Steps ↔",
    description: "Divides each row into this many steps along time.",
    default: 8,
    min: 1,
    max: 16,
    step: 1,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}SeqStepsY`] = {
    kind: "number",
    name: `Sequencer Steps Y ${idx}`,
    label: "Rows ↕",
    description: "Stacks this many rows across the pitch range.",
    default: 4,
    min: 1,
    max: 8,
    step: 1,
    includeInStep: true,
  };
  modulatorDefs[`modulator${idx}SeqLoopBeats`] = {
    kind: "number",
    name: `Sequencer Loop Beats ${idx}`,
    label: "Loop ↔",
    description: "Repeats the whole grid every this many beats.",
    default: 1,
    min: 1 / 64,
    max: 32,
    step: 0.0001,
    marks: beatMarksWithOff,
    scale: "log",
    unit: BEAT_UNIT,
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}SeqLoopSemis`] = {
    kind: "number",
    name: `Sequencer Loop Semis ${idx}`,
    label: "Loop ↕",
    description: "Spreads the grid's rows over this many semitones before repeating.",
    default: 12,
    min: 1,
    max: 96,
    step: 1,
    marks: PITCH_VALUES_NO_FRACTIONS,
    unit: SEMITONE_UNIT,
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}SeqSwing`] = {
    kind: "number",
    name: `Sequencer Swing ${idx}`,
    label: "Swing",
    description: "Pushes odd-numbered steps later for a swung feel.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: !isWindows,
  };
  modulatorDefs[`modulator${idx}SeqData`] = {
    kind: "string",
    name: `Sequencer Data ${idx}`,
    label: "Seq Data",
    description: "Holds the on/off state of every cell in the grid.",
    default: JSON.stringify({
      values: Array.from({ length: 4 }, () => Array.from({ length: 8 }, () => 1)),
    }),
    includeInStep: true,
  };
}

// --- Macro Definitions ---
// Macros are brush-level modulation sources with user-editable names.
// Their values live on the Brush (macroValues); the parameter def is only
// used so the existing ParameterControl / ParamMenu UI can render them.
const macroDefs: Record<string, ParameterDefInput> = {};
for (let i = 0; i < NUM_MACROS; i++) {
  const idx = i + 1;
  macroDefs[`macro${idx}Value`] = {
    kind: "number",
    name: `Macro ${idx}`,
    label: `Macro ${idx}`,
    description: "Drives any modulatable parameter from one knob. Rename it from its label menu.",
    default: 50,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    modulatable: true,
    modulationSourcesAllowed: "contextualOnly",
  };
}

// --- Base Definitions (Brush, Effects, App) ---
const baseParameterDefs: Partial<Record<ParameterKey, ParameterDefInput>> = {
  // --- Brush Parameters ---
  brushWrapMode: {
    kind: "options",
    name: "Wrap Mode",
    label: "Wrap",
    description: "Wraps a stroke that runs off an edge back onto the opposite side, in time, pitch, or both.",
    default: 0,
    options: WRAP_MODES,
    includeInStep: true,
  },
  brushIntensity: {
    kind: "number",
    name: "Brush Strength",
    label: "Strength",
    description: "Sets how hard the effect hits. Lower it to blend a stroke in rather than replace what is there.",
    default: 100,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushIterations: {
    kind: "number",
    name: "Brush Iterations",
    label: "Iterations",
    description:
      "Re-runs the whole effect chain this many times inside one stamp, feeding its own output back in. Echoes, feedback, spectral delay.",
    default: 1,
    min: 1,
    max: 20,
    step: 1,
    includeInStep: true,
  },
  brushPan: {
    kind: "number",
    name: "Pan",
    label: "Pan",
    description: "Pans the processed result left or right, leaving the untouched audio where it was.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushSizeTime: {
    kind: "number",
    name: "Brush Size Time",
    label: "Size ↔",
    description:
      'Horizontal brush size. At the minimum ("Grid") it tracks the time grid; at the maximum ("Full") it fills the full file width and anchors to the left edge regardless of cursor position.',
    default: 1,
    min: 0,
    max: 32,
    step: 0.01,
    unit: BEAT_UNIT,
    scale: "log",
    marks: [{ value: 0, label: "Grid" }, ...BEAT_VALUES.filter((m) => m.value !== 32), { value: 32, label: "Full" }],
    includeInStep: true,
  },
  brushCurveTime: {
    kind: "number",
    name: "Brush Curve Time",
    label: "Curve ↔",
    description:
      "Shapes the stroke's edges in time: −100% is a sharp spike, 0% a linear triangle, +100% a hard rectangle.",
    default: 100,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushSkewTime: {
    kind: "number",
    name: "Brush Skew Time",
    label: "Skew ↔",
    description:
      "Moves the envelope peak through time: −100% is an early pluck, 0% centred, +100% a delayed hit. Contextual Time modulation flattens the envelope instead — use a pattern modulator slower than the brush for a peak that slides.",
    default: -100,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushSizePitch: {
    kind: "number",
    name: "Brush Size Pitch",
    label: "Size ↕",
    description:
      'Vertical brush size. At the minimum ("Grid") it tracks the pitch grid; at the maximum ("Full") it fills the full file height and anchors to the bottom regardless of cursor position.',
    default: 48,
    min: 0,
    max: 128,
    step: 0.1,
    unit: SEMITONE_UNIT,
    marks: [{ value: 0, label: "Grid" }, ...PITCH_VALUES, { value: 128, label: "Full" }],
    includeInStep: true,
  },
  brushCurvePitch: {
    kind: "number",
    name: "Brush Curve Pitch",
    label: "Curve ↕",
    description:
      "Shapes the stroke's edges in pitch: −100% is a sharp spike, 0% a linear triangle, +100% a hard rectangle.",
    default: 100,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushSkewPitch: {
    kind: "number",
    name: "Brush Skew Pitch",
    label: "Skew ↕",
    description:
      "Moves the envelope peak through pitch: −100% sits at the bottom, 0% centred, +100% at the top. Contextual Pitch modulation flattens the envelope instead — use a pattern modulator wider than the brush for a peak that slides.",
    default: -100,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  brushAnchorMode: {
    kind: "options",
    name: "Brush Anchor",
    label: "Anchor",
    description:
      "Puts the cursor on the stamp's bottom-left onset corner, so snapping locks hits to the grid, or on its centre, so snapping lands the envelope peak on the grid. Corner for rhythm, Center for pads.",
    default: 0,
    options: BRUSH_ANCHOR_MODES,
    includeInStep: true,
  },
  blendMode: {
    kind: "options",
    name: "Blend Mode",
    label: "Blend mode",
    description: "Decides how the processed result merges back over the original — crossfade, add, mask, and the rest.",
    default: 0,
    options: BLEND_MODES,
    includeInStep: true,
  },
  algorithm: {
    kind: "options",
    name: "Warp Algorithm",
    label: "Warp algo",
    description:
      "Picks how phase is rebuilt when sound is moved in time or pitch. Neutral keeps hits sharp; Flangey and Noisey smear on purpose.",
    default: NEUTRAL_ALGORITHM,
    options: ALGORITHMS,
    includeInStep: true,
  },
  sourceFile: {
    kind: "file",
    name: "Source File",
    label: "Source",
    description:
      "Reads from another file, or another part of this one, instead of from under the brush. This is the clone stamp.",
    default: null,
    includeInStep: true,
    pickMode: "canvas",
    timeOffsetParam: "sourceTimeOffset" as ParameterKey,
    pitchOffsetParam: "sourcePitchOffset" as ParameterKey,
    previewMode: "brushRect",
    enableShortcut: true,
  },
  sourcePositionMode: {
    kind: "options",
    name: "Source Position Mode",
    label: "Tracking",
    description:
      "Drags the source along with the stroke, reads one fixed spot every time, or holds the offset you started with.",
    default: "follow" as const,
    options: [
      { value: "follow", label: "Follow" },
      { value: "fixed", label: "Fixed" },
      { value: "anchored", label: "Anchored" },
    ],
    includeInStep: true,
  },
  sourceDataMode: {
    kind: "options",
    name: "Source Data Mode",
    label: "Read From",
    description:
      "Reads the source file's edited state, or its original unedited analysis. Original is how you undo a region locally.",
    default: "current" as const,
    options: [
      { value: "current", label: "Current" },
      { value: "original", label: "Original" },
    ],
    includeInStep: true,
  },
  sourceTimeOffset: {
    kind: "number",
    name: "Source Time",
    label: "Time ↔",
    description: "Sets where along the source file's length to read from.",
    default: 0,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },
  sourcePitchOffset: {
    kind: "number",
    name: "Source Pitch",
    label: "Pitch ↕",
    description: "Sets where across the source file's frequency range to read from.",
    default: 0,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
  },

  // --- Effect Parameters ---
  dynamicsThresholdDb: {
    kind: "number",
    name: "Threshold",
    label: "Threshold",
    description:
      "Splits loud from quiet. Everything above takes the upper ratio, everything below takes the lower one.",
    default: -20.0,
    min: -60,
    max: 0,
    step: 0.1,
    unit: "dB",
    includeInStep: true,
    modulatable: true,
    effectType: "dynamics",
  },
  dynamicsUpperRatio: {
    kind: "number",
    name: "Upper Ratio",
    label: "Upper",
    description:
      "Multiplies everything above the threshold: 1 leaves it alone, 0.5 compresses, 2 expands, 0 gates it out, −1 inverts it.",
    default: 1.0,
    min: -8.0,
    max: 8.0,
    step: 0.1,
    unit: "×",
    includeInStep: true,
    modulatable: true,
    effectType: "dynamics",
  },
  dynamicsLowerRatio: {
    kind: "number",
    name: "Lower Ratio",
    label: "Lower",
    description:
      "Multiplies everything below the threshold: 1 leaves it alone, 0.5 compresses, 2 expands, 0 gates it out, −1 inverts it.",
    default: 1.0,
    min: -8.0,
    max: 8.0,
    step: 0.1,
    unit: "×",
    includeInStep: true,
    modulatable: true,
    effectType: "dynamics",
  },
  dynamicsKnee: {
    kind: "number",
    name: "Knee",
    label: "Knee",
    description: "Softens the crossover at the threshold. 0 switches abruptly, higher fades between the two ratios.",
    default: 6.0,
    min: 0.0,
    max: 48.0,
    step: 0.5,
    unit: "dB",
    includeInStep: true,
    modulatable: true,
    effectType: "dynamics",
  },
  dynamicsGainDb: {
    kind: "number",
    name: "Gain",
    label: "Gain",
    description: "Lifts or drops the level after processing. Take it all the way down to erase.",
    default: 0.0,
    min: -80,
    max: 24,
    step: 0.1,
    unit: "dB",
    includeInStep: true,
    modulatable: true,
    effectType: "dynamics",
  },
  transformShiftBeats: {
    kind: "number",
    name: "Shift Beats",
    label: "Shift ↔",
    description: "Slides the sound earlier or later, in beats.",
    default: 0,
    min: -32,
    max: 32,
    step: 0.01,
    scale: "logBipolar",
    unit: BEAT_UNIT,
    marks: [...negBeatMarks, zeroBeatMark, ...posBeatMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "transform",
  },
  transformShiftSemis: {
    kind: "number",
    name: "Shift Semis",
    label: "Shift ↕",
    description: "Slides the sound up or down, in semitones.",
    default: 0.0,
    min: -96,
    max: 96,
    step: 0.01,
    unit: SEMITONE_UNIT,
    marks: [...negPitchMarks, zeroPitchMark, ...posPitchMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "transform",
  },
  transformScaleTime: {
    kind: "number",
    name: "Scale Time",
    label: "Scale ↔",
    description: "Stretches or squashes the sound in time. Negative values play it backwards.",
    default: 1.0,
    min: -256,
    max: 256,
    step: 0.001,
    scale: "logBipolar",
    unit: MULTIPLIER_UNIT,
    marks: [...negMultMarks, ...posMultMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "transform",
  },
  transformScalePitch: {
    kind: "number",
    name: "Scale Pitch",
    label: "Scale ↕",
    description: "Stretches or squashes the sound in pitch, spreading or collapsing its harmonics.",
    default: 1.0,
    min: -256,
    max: 256,
    step: 0.001,
    scale: "logBipolar",
    unit: MULTIPLIER_UNIT,
    marks: [...negMultMarks, ...posMultMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "transform",
  },
  transformRotation: {
    kind: "number",
    name: "Rotation",
    label: "Rotation",
    description: "Turns the sound on the canvas, trading time for pitch — a rising sweep becomes a chord and back.",
    default: 0.0,
    min: -180,
    max: 180,
    step: 0.1,
    unit: "°",
    includeInStep: true,
    modulatable: true,
    effectType: "transform",
  },
  transformEdgeMode: {
    kind: "options",
    name: "Edge Mode",
    label: "Edge",
    description:
      "Decides what happens to sound pushed past the brush edge: bleed it out, wrap it round, or cut it off.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "transform",
  },
  sortDirection: {
    kind: "options",
    name: "Sort Direction",
    label: "Direction",
    description: "Sorts along time or along pitch.",
    default: 0,
    options: [
      { value: 0, label: "Horizontal" },
      { value: 1, label: "Vertical" },
      { value: 2, label: "Both" },
    ],
    includeInStep: true,
    effectType: "sort",
  },
  sortOrder: {
    kind: "options",
    name: "Sort Order",
    label: "Order",
    description: "Sorts loudest-first or quietest-first.",
    default: 0,
    options: [
      { value: 0, label: "Forwards" },
      { value: 1, label: "Backwards" },
    ],
    includeInStep: true,
    effectType: "sort",
  },
  sortBy: {
    kind: "options",
    name: "Sort By",
    label: "Sort By",
    description: "Ranks bins by loudness or by phase.",
    default: 0,
    options: [
      { value: 0, label: "Magnitude" },
      { value: 1, label: "Phase" },
      { value: 2, label: "dB" },
      { value: 3, label: "Frequency" },
      { value: 4, label: "Pan" },
    ],
    includeInStep: true,
    effectType: "sort",
  },
  sortStereoMode: {
    kind: "options",
    name: "Sort Stereo Mode",
    label: "Stereo",
    description: "Sorts both channels together, keeping the stereo image intact, or separately, tearing it apart.",
    default: 0,
    options: [
      { value: 0, label: "Linked" },
      { value: 1, label: "Independent" },
    ],
    includeInStep: true,
    effectType: "sort",
  },
  blurAmountTime: {
    kind: "number",
    name: "Blur Amount Time",
    label: "Blur ↔",
    description: "Smears energy backwards and forwards in time. Reverb tails and freezes live here.",
    default: 100,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "blur",
  },
  blurAmountPitch: {
    kind: "number",
    name: "Blur Amount Pitch",
    label: "Blur ↕",
    description: "Smears energy up and down in pitch, blending neighbouring harmonics into a wash.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "blur",
  },
  blurNoiseTime: {
    kind: "number",
    name: "Blur Noise Time",
    label: "Noise ↔",
    description: "Randomizes each time-axis blur tap, roughening the smear into something grainier.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "blur",
  },
  blurNoisePitch: {
    kind: "number",
    name: "Blur Noise Pitch",
    label: "Noise ↕",
    description: "Randomizes each pitch-axis blur tap, roughening the smear into something grainier.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "blur",
  },
  blurSamplesX: {
    kind: "number",
    name: "Blur Samples Time",
    label: "Samples ↔",
    description: "Trades quality for speed on the time blur. Fewer samples grain up, more cost more.",
    default: 16,
    min: 1,
    max: 64,
    step: 1,
    includeInStep: true,
    effectType: "blur",
  },
  blurSamplesY: {
    kind: "number",
    name: "Blur Samples Pitch",
    label: "Samples ↕",
    description: "Trades quality for speed on the pitch blur. Fewer samples grain up, more cost more.",
    default: 16,
    min: 1,
    max: 64,
    step: 1,
    includeInStep: true,
    effectType: "blur",
  },
  blurEdgeMode: {
    kind: "options",
    name: "Edge Mode",
    label: "Edge",
    description: "Decides what the blur reads past the brush edge: bleed, wrap, or nothing.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "blur",
  },
  blurOrigin: {
    kind: "options",
    name: "Blur Origin",
    label: "Origin",
    description:
      "Anchors the smear to one side. Left trails forwards in time for a reverb tail, Right runs backwards for pre-echo, Middle spreads both ways.",
    default: 0,
    options: [
      { value: 0, label: "Left" },
      { value: 1, label: "Middle" },
      { value: 2, label: "Right" },
    ],
    includeInStep: true,
    effectType: "blur",
  },
  cloneSpaceBeats: {
    kind: "number",
    name: "Clone Space Beats",
    label: "Space ↔",
    description: "Sets the gap between copies in beats. This is the echo time.",
    default: 0.25,
    min: -32,
    max: 32,
    step: 0.001,
    scale: "logBipolar",
    unit: BEAT_UNIT,
    marks: [...negBeatMarks, zeroBeatMark, ...posBeatMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "clone",
  },
  cloneSpaceSemis: {
    kind: "number",
    name: "Clone Space Semis",
    label: "Space ↕",
    description: "Sets the gap between copies in semitones. 7 gives fifths, 12 gives octaves.",
    default: 0,
    min: -96,
    max: 96,
    step: 0.01,
    unit: SEMITONE_UNIT,
    marks: [...negPitchMarks, zeroPitchMark, ...posPitchMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "clone",
  },
  cloneCountX: {
    kind: "number",
    name: "Clone Count Time",
    label: "Copies ↔",
    description: "Repeats the sound this many times along time.",
    default: 4,
    min: 1,
    max: 64,
    step: 1,
    includeInStep: true,
    modulatable: false,
    effectType: "clone",
  },
  cloneCountY: {
    kind: "number",
    name: "Clone Count Pitch",
    label: "Copies ↕",
    description: "Repeats the sound this many times up or down the pitch axis.",
    default: 1,
    min: 1,
    max: 64,
    step: 1,
    includeInStep: true,
    modulatable: false,
    effectType: "clone",
  },
  cloneDecay: {
    kind: "number",
    name: "Clone Decay",
    label: "Decay",
    description:
      "Fades each successive copy. 0% holds them all level, 100% silences the outermost. Decays multiply across the two axes.",
    default: 50,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "clone",
  },
  cloneDirectionX: {
    kind: "options",
    name: "Clone Direction Time",
    label: "Dir. ↔",
    description: "Throws the copies forwards, backwards, or both ways in time.",
    default: 0,
    options: [
      { value: 0, label: "Forward" },
      { value: 1, label: "Middle" },
      { value: 2, label: "Backward" },
    ],
    includeInStep: true,
    effectType: "clone",
  },
  cloneDirectionY: {
    kind: "options",
    name: "Clone Direction Pitch",
    label: "Dir. ↕",
    description: "Throws the copies upwards, downwards, or both ways in pitch.",
    default: 1,
    options: [
      { value: 0, label: "Up" },
      { value: 1, label: "Middle" },
      { value: 2, label: "Down" },
    ],
    includeInStep: true,
    effectType: "clone",
  },
  cloneEdgeMode: {
    kind: "options",
    name: "Clone Edge Mode",
    label: "Edge",
    description: "Decides what happens to copies that land past the brush edge: bleed, wrap, or cut.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "clone",
  },
  cloneShapeX: {
    kind: "options",
    name: "Clone Shape Time",
    label: "Shape ↔",
    description: "Spaces the copies evenly, by widening gaps, by narrowing gaps, or unevenly.",
    default: "even",
    options: CLONE_SHAPE_KEYS.filter((key) => cloneShapes[key].timeLabel !== null).map((key) => ({
      value: key,
      label: cloneShapes[key].timeLabel as string,
    })),
    includeInStep: true,
    effectType: "clone",
  },
  cloneShapeY: {
    kind: "options",
    name: "Clone Shape Pitch",
    label: "Shape ↕",
    description:
      "Spaces the copies evenly, by the harmonic series, by doubling gaps, stretched, or on the selected scale.",
    default: "even",
    options: CLONE_SHAPE_KEYS.map((key) => ({ value: key, label: cloneShapes[key].label })),
    includeInStep: true,
    effectType: "clone",
  },
  cloneSumMode: {
    kind: "options",
    name: "Clone Sum Mode",
    label: "Sum",
    description: "Sets whether copies landing together add as waves, which can cancel, or as levels, which cannot.",
    default: 0,
    options: [
      { value: 0, label: "Coherent" },
      { value: 1, label: "Constructive" },
    ],
    includeInStep: true,
    effectType: "clone",
  },
  synthesizeBrushType: {
    kind: "options",
    name: "Synthesize Type",
    label: "Type",
    description: "Paints noise, a tone, or an impulse into the brush area.",
    default: 0,
    options: SYNTHESIZE_TYPES,
    includeInStep: true,
    effectType: "synthesize",
  },
  evolveFlow: {
    kind: "number",
    name: "Flow",
    label: "Flow",
    description: "Pushes energy along the sound's own gradients so it flows. Negative reverses the current.",
    default: 20,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveSpread: {
    kind: "number",
    name: "Spread",
    label: "Spread",
    description: "Bleeds energy outwards, or pulls it inwards to sharpen. Positive spreads, negative concentrates.",
    default: 40,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveGrow: {
    kind: "number",
    name: "Grow",
    label: "Grow",
    description: "Feeds the sound back into itself so it grows. Negative eats it away instead.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveSwirl: {
    kind: "number",
    name: "Swirl",
    label: "Swirl",
    description: "Curls the flow into a rotation, clockwise or anticlockwise.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveDriftX: {
    kind: "number",
    name: "Drift X",
    label: "Drift ↔",
    description: "Biases the flow towards earlier or later in time.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveDriftY: {
    kind: "number",
    name: "Drift Y",
    label: "Drift ↕",
    description: "Biases the flow towards lower or higher pitch.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveDecay: {
    kind: "number",
    name: "Decay",
    label: "Decay",
    description: "Bleeds energy away each pass so the pattern dies out. Negative feeds it instead.",
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveScaleX: {
    kind: "number",
    name: "Scale X",
    label: "Scale ↔",
    description: "Widens the neighbourhood each point reads along time, coarsening the pattern.",
    default: 50,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveScaleY: {
    kind: "number",
    name: "Scale Y",
    label: "Scale ↕",
    description: "Widens the neighbourhood each point reads along pitch, coarsening the pattern.",
    default: 50,
    min: -100,
    max: 100,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "evolve",
  },
  evolveEdgeMode: {
    kind: "options",
    name: "Edge Mode",
    label: "Edge",
    description: "Decides what the simulation reads past the brush edge: bleed, wrap, or nothing.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "evolve",
  },
  binauralAzimuth: {
    kind: "number",
    name: "Azimuth",
    label: "Azimuth",
    description: "Places the sound around the listener: 0° is front, 90° right, −90° left, 180° behind.",
    default: 0,
    min: -180,
    max: 180,
    step: 1,
    unit: "°",
    includeInStep: true,
    modulatable: true,
    effectType: "binaural",
  },
  binauralDistance: {
    kind: "number",
    name: "Distance",
    label: "Distance",
    description: "Pushes the sound away, quietening it and rolling off its top end as it goes.",
    default: 1,
    min: 0.1,
    max: 10,
    step: 0.1,
    unit: "m",
    includeInStep: true,
    modulatable: true,
    effectType: "binaural",
  },
  binauralStereoAngle: {
    kind: "number",
    name: "Stereo Angle",
    label: "Stereo",
    description:
      "Widens the source around its position. At 0° it collapses to a point, at 180° the channels sit ±90° either side of it.",
    default: 180,
    min: 0,
    max: 180,
    step: 1,
    unit: "°",
    includeInStep: true,
    modulatable: true,
    effectType: "binaural",
  },
  // --- Transmute Parameters ---
  transmuteMode: {
    kind: "options",
    name: "Transmute Mode",
    label: "Mode",
    description: "Picks which way magnitude and phase get bent against each other.",
    default: 0,
    options: [
      { value: 0, label: "Swap Mag/Phase" },
      { value: 1, label: "Complex Power" },
      { value: 2, label: "Phase Rotate" },
      { value: 3, label: "Phase Quantize" },
      { value: 4, label: "Stereo Cross" },
      { value: 5, label: "Phase Gate" },
    ],
    includeInStep: true,
    effectType: "transmute",
  },
  transmuteAmount: {
    kind: "number",
    name: "Amount",
    label: "Amount",
    description:
      "Drives whichever mode is selected — blend for Swap and Stereo Cross, exponent for Complex Power, rotations for Phase Rotate, step count (×8) for Phase Quantize, oscillations for Phase Gate.",
    default: 1.0,
    min: -8.0,
    max: 8.0,
    step: 0.01,
    unit: "",
    includeInStep: true,
    modulatable: true,
    effectType: "transmute",
  },
  transmuteCurve: {
    kind: "number",
    name: "Curve",
    label: "Curve",
    description:
      "Shapes the mode a second time — the frequency power law for Phase Rotate, the phase blend for Stereo Cross, the gate sharpness for Phase Gate.",
    default: 1.0,
    min: -4.0,
    max: 4.0,
    step: 0.01,
    unit: "",
    includeInStep: true,
    modulatable: true,
    effectType: "transmute",
  },

  // --- Reflow Parameters ---
  reflowMode: {
    kind: "options",
    name: "Reflow Mode",
    label: "Mode",
    description:
      "Picks what each pitch is pulled toward — the nearest note of the scale, one fixed pitch, or a stretched copy of its own spectrum.",
    default: 0,
    options: [
      { value: 0, label: "Scale" },
      { value: 1, label: "Pitch" },
      { value: 2, label: "Stretch" },
    ],
    includeInStep: true,
    effectType: "reflow",
  },
  reflowAmount: {
    kind: "number",
    name: "Amount",
    label: "Amount",
    description:
      "Sets how far each pitch moves toward its target. Negative values push away from the target; past 100 overshoots it.",
    default: 100,
    min: -100,
    max: 200,
    step: 1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "reflow",
  },
  reflowPitch: {
    kind: "number",
    name: "Pitch",
    label: "Pitch",
    description:
      "Sets the pitch that Pitch mode pulls toward and the fixed point Stretch bends around, in semitones from A4.",
    default: -12,
    min: -48,
    max: 24,
    step: 1,
    unit: "st",
    includeInStep: true,
    modulatable: true,
    effectType: "reflow",
  },
  reflowStretch: {
    kind: "number",
    name: "Stretch",
    label: "Stretch",
    description:
      "Bends the spectrum's spacing in Stretch mode — 1 leaves it alone, above 1 spreads it apart, 0 collapses it onto the fixed point, negative mirrors it.",
    default: 1,
    min: -2,
    max: 3,
    step: 0.01,
    unit: "",
    includeInStep: true,
    modulatable: true,
    effectType: "reflow",
  },
  reflowReach: {
    kind: "number",
    name: "Reach",
    label: "Reach",
    description: "Limits the pull to pitches within this distance of their target; everything farther stays put.",
    default: 12,
    min: 0.1,
    max: 48,
    step: 0.1,
    unit: "st",
    includeInStep: true,
    modulatable: true,
    effectType: "reflow",
  },

  // --- Waveshape Parameters ---
  waveshapeMode: {
    kind: "options",
    name: "Waveshape Mode",
    label: "Shape",
    description: "Picks the distortion curve the spectrum is pushed through. Drive sets how hard.",
    default: 0,
    options: [
      { value: 0, label: "Soft Clip" },
      { value: 1, label: "Hard Clip" },
      { value: 2, label: "Rectify" },
      { value: 3, label: "Fold" },
      { value: 4, label: "Wrap" },
      { value: 5, label: "Sine" },
    ],
    includeInStep: true,
    effectType: "waveshape" as EffectType,
  },
  waveshapeDrive: {
    kind: "number",
    name: "Drive",
    label: "Drive",
    description:
      "Pushes the signal harder into the shaping curve. For Fold, Wrap and Sine this is how many times it cycles through.",
    default: 1.0,
    min: 0.01,
    max: 16.0,
    step: 0.01,
    unit: MULTIPLIER_UNIT,
    includeInStep: true,
    modulatable: true,
    effectType: "waveshape" as EffectType,
  },
  waveshapeTilt: {
    kind: "number",
    name: "Tilt",
    label: "Tilt",
    description: "Leans the shaping onto one phase axis, biasing the result towards 0°/180° or towards ±90°.",
    default: 0.0,
    min: -1.0,
    max: 1.0,
    step: 0.01,
    unit: "",
    includeInStep: true,
    modulatable: true,
    effectType: "waveshape" as EffectType,
  },

  convolveIrFile: {
    kind: "file",
    name: "Convolve IR",
    label: "IR",
    description: "Picks the sound whose character gets printed onto this one. A reverb IR gives you its room.",
    default: null,
    includeInStep: true,
    effectType: "convolve" as EffectType,
    pickMode: "modal",
  },
  convolveIrTimeOffset: {
    kind: "number",
    name: "IR Start",
    label: "Start",
    description: "Starts reading the IR from this point, so you can skip a reverb's attack and keep only its tail.",
    default: 0,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
    includeInStep: true,
    modulatable: true,
    effectType: "convolve" as EffectType,
  },
  convolveIrPitchShift: {
    kind: "number",
    name: "IR Pitch Shift",
    label: "Pitch Shift",
    description: "Transposes the IR, moving the resonances of the space it carries.",
    default: 0,
    min: -24,
    max: 24,
    step: 0.01,
    unit: SEMITONE_UNIT,
    marks: [...negPitchMarks, zeroPitchMark, ...posPitchMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "convolve" as EffectType,
  },
  convolveIrSize: {
    kind: "number",
    name: "IR Size",
    label: "Taps",
    description: "Reads this many frames of the IR. More gives a longer tail and costs more to render.",
    default: 64,
    min: 1,
    max: 512,
    step: 1,
    unit: "",
    includeInStep: true,
    modulatable: true,
    effectType: "convolve" as EffectType,
  },
  convolveGainDb: {
    kind: "number",
    name: "Gain",
    label: "Gain",
    description: "Lifts or drops the convolved signal against the original.",
    default: 0,
    min: -36,
    max: 36,
    step: 0.1,
    unit: "dB",
    includeInStep: true,
    modulatable: true,
    effectType: "convolve" as EffectType,
  },
  convolveIrRate: {
    kind: "number",
    name: "IR Rate",
    label: "Rate",
    description:
      "Steps through the source once per IR tap: 1 is a forward reverb at normal speed, −1 reverses it, and anything above or below 1 stretches or compresses the tail.",
    default: 1.0,
    min: -256,
    max: 256,
    step: 0.001,
    scale: "logBipolar",
    unit: MULTIPLIER_UNIT,
    marks: [...negMultMarks, ...posMultMarks],
    includeInStep: true,
    modulatable: true,
    effectType: "convolve" as EffectType,
  },
  convolveEdgeMode: {
    kind: "options",
    name: "Convolve Edge Mode",
    label: "Edge",
    description: "Decides what happens to taps that land past the brush edge: bleed, wrap, or cut.",
    default: 1,
    options: EDGE_MODE,
    includeInStep: true,
    effectType: "convolve" as EffectType,
  },

  effects: {
    kind: "options",
    name: "Effects",
    label: "Effects",
    description: "Holds this step's effect chain, applied top to bottom.",
    default: DEFAULT_EFFECTS,
    options: [],
    includeInStep: true,
  },

  // --- App/UI Parameters ---
  displayMinDb: {
    kind: "number",
    name: "Display Min dB",
    label: "Min dB",
    description: "Sets the level the display draws as black. Raise it to hide quiet detail.",
    default: -70.0,
    min: -120,
    max: 0,
    step: 1,
    unit: "dB",
  },
  displayMaxDb: {
    kind: "number",
    name: "Display Max dB",
    label: "Max dB",
    description: "Sets the level the display draws as full brightness. Lower it to bring quiet detail up.",
    default: 0.0,
    min: -120,
    max: 24,
    step: 1,
    unit: "dB",
  },
  magnitudeLimit: {
    kind: "number",
    name: "Magnitude Limit",
    label: "Mag. Limit",
    description:
      "Soft-clips each bin's magnitude. 0 turns it off — raise it only to stop a feedback effect running away, since the audio limiter already keeps the output safe.",
    default: 0.0,
    min: 0.0,
    max: 2.0,
    step: 0.01,
    unit: "x",
  },
  gridSizeBeats: {
    kind: "number",
    name: "Grid Size Beats",
    label: "Beats",
    description:
      "Spaces the time grid, in beats. Set it to 'Onsets' to snap to the file's detected hits instead, which lands a stamp exactly on a transient rather than near it.",
    default: 1,
    // Onsets sit past the bottom of the beat range rather than inside it, so
    // the travel between the smallest and largest beat stays even and the
    // sentinel is reached by taking the control all the way down.
    min: BEAT_VALUES[0].value,
    max: 32,
    step: 0.0001,
    leftValue: { value: ONSETS_GRID_VALUE, label: "Onsets" },
    marks: [{ value: ONSETS_GRID_VALUE, label: "Onsets" }, ...BEAT_VALUES],
    scale: "log",
  },
  snapTime: {
    kind: "boolean",
    name: "Snap Time",
    label: "Snap Time",
    description: "Locks strokes to the time grid.",
    default: true,
  },
  limiterEnabled: {
    kind: "boolean",
    name: "Limiter",
    label: "Limiter",
    description:
      "Bakes a true-peak limiter into the synthesized audio so it can't clip on playback or export. Bypass it to hear or print the raw synthesis.",
    default: true,
  },
  gridSwing: {
    kind: "number",
    name: "Grid Swing",
    label: "Swing",
    description:
      "Swings the time grid. 0% is straight, ~67% a triplet feel, 100% shifts odd grid lines by half a cell.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
  },
  accumulate: {
    kind: "boolean",
    name: "Accumulate",
    label: "Accumulate",
    description: "Lets a stroke build up where it crosses itself. Off, dragging back and forth won't double-apply.",
    default: false,
    includeInStep: true,
  },
  gridSizeSemis: {
    kind: "number",
    name: "Grid Size Semis",
    label: "Semis",
    description:
      "Spaces the pitch grid, in semitones. Set it to 'Scale' to snap to the selected scale instead of a fixed interval.",
    default: 24,
    min: 0,
    max: 96,
    step: 1,
    marks: [{ value: 0, label: "Scale" }, ...PITCH_VALUES],
  },
  snapPitch: {
    kind: "boolean",
    name: "Snap Pitch",
    label: "Snap Pitch",
    description: "Locks strokes to the pitch grid, or to the selected scale when the pitch grid is set to 'Scale'.",
    default: true,
  },
  minFreq: {
    kind: "number",
    name: "Minimum Frequency",
    label: "Min. Freq.",
    description:
      "Sets the lowest frequency the analysis covers. Raising it spends resolution where the sound actually is.",
    default: 16.3516, // C0
    min: 10,
    max: 100,
    step: 0.01,
    unit: "Hz",
  },
  scaleTonic: {
    kind: "options",
    name: "Scale Tonic",
    label: "Tonic",
    description: "Sets the scale's root note.",
    default: "C",
    options: [
      { value: "C", label: "C" },
      { value: "C#", label: "C#" },
      { value: "D", label: "D" },
      { value: "D#", label: "D#" },
      { value: "E", label: "E" },
      { value: "F", label: "F" },
      { value: "F#", label: "F#" },
      { value: "G", label: "G" },
      { value: "G#", label: "G#" },
      { value: "A", label: "A" },
      { value: "A#", label: "A#" },
      { value: "B", label: "B" },
    ],
  },
  scaleType: {
    kind: "options",
    name: "Scale Type",
    label: "Type",
    description: "Picks the scale used for pitch snapping and for every scale-based effect and modulator.",
    default: "major",
    options: ScaleType.all().map(({ name }) => ({
      value: name,
      label: startCase(name),
    })),
  },
  bandsPerOctave: {
    kind: "options",
    name: "Resolution Mode",
    label: "Resolution",
    description:
      "Trades time resolution against pitch resolution: sharper transients at one end, more precise pitch at the other.",
    default: 36,
    options: BANDS_PER_OCTAVE_VALUES,
  },
  linkLatencyMs: {
    kind: "number",
    name: "Link Latency",
    label: "Link Latency",
    description: "Compensates for output latency when synced over Ableton Link. Positive values play earlier.",
    default: 0,
    min: -500,
    max: 500,
    step: 1,
    unit: "ms",
  },
};

// --- Final Parameter Definitions Builder ---

const combinedDefs: Partial<Record<ParameterKey, ParameterDefInput>> = {
  ...baseParameterDefs,
  ...modulatorDefs,
  ...macroDefs,
};

const finalParameterDefs: Partial<Record<ParameterKey, ParameterDef>> = { ...combinedDefs };

for (const [key, def] of Object.entries(combinedDefs)) {
  if (def.kind === "number" && def.modulatable) {
    const modKeys: ParameterKey[] = [];
    const contextualOnly = def.modulationSourcesAllowed === "contextualOnly";

    // Generate pattern modulator amounts (Mod1, Mod2, Mod3)
    if (!contextualOnly) {
      for (let i = 0; i < NUM_MODULATORS; i++) {
        const modIndex = i + 1;
        const modAmountKey = `${key}Mod${modIndex}Amount` as ParameterKey;
        modKeys.push(modAmountKey);

        finalParameterDefs[modAmountKey] = {
          kind: "number",
          name: `${def.name} Mod ${modIndex} Amount`,
          label: `Mod ${modIndex}`,
          description: `Drives ${def.name} from Modulator ${modIndex}.`,
          default: 0,
          min: -100,
          max: 100,
          step: 0.1,
          unit: "%",

          includeInStep: true,
          effectType: def.effectType, // Inherit effectType from parent parameter
        };
      }
    }

    // Generate contextual modulation amounts (Iteration, Time, Pitch, Random, Step)
    for (const source of CONTEXTUAL_MOD_SOURCES) {
      const contextModKey = `${key}Mod${source.key}` as ParameterKey;

      finalParameterDefs[contextModKey] = {
        kind: "number",
        name: `${def.name} Mod ${source.key}`,
        label: source.label,
        description: `Drives ${def.name} from ${source.label}.`,
        default: 0,
        min: -100,
        max: 100,
        step: 0.1,
        unit: "%",

        includeInStep: true,
        effectType: def.effectType, // Inherit effectType from parent parameter
      };
    }

    // Generate macro modulation amounts (Macro1..Macro4)
    if (!contextualOnly) {
      for (let i = 0; i < NUM_MACROS; i++) {
        const macroIndex = i + 1;
        const macroAmountKey = `${key}ModMacro${macroIndex}Amount` as ParameterKey;

        finalParameterDefs[macroAmountKey] = {
          kind: "number",
          name: `${def.name} Macro ${macroIndex} Amount`,
          label: `Macro ${macroIndex}`,
          description: `Drives ${def.name} from Macro ${macroIndex}.`,
          default: 0,
          min: -100,
          max: 100,
          step: 0.1,
          unit: "%",

          includeInStep: true,
          effectType: def.effectType,
        };
      }
    }
  }
}

export const parameterDefs = finalParameterDefs;

export const getParameterDef = (key: ParameterKey): ParameterDef => {
  const parameterDef = parameterDefs[key];

  if (!parameterDef) {
    throw new Error(`Parameter ${key} is not defined.`);
  }

  return parameterDef;
};

export const getNumberParameterDef = (key: ParameterKey): NumberParameter => {
  const parameterDef = getParameterDef(key);

  if (parameterDef.kind !== "number") {
    throw new Error(`Parameter ${key} is not a number parameter.`);
  }
  return parameterDef as NumberParameter;
};

export const getBooleanParameterDef = (key: ParameterKey): BooleanParameter => {
  const parameterDef = getParameterDef(key);

  if (parameterDef.kind !== "boolean") {
    throw new Error(`Parameter ${key} is not a boolean parameter.`);
  }
  return parameterDef as BooleanParameter;
};

export const getOptionsParameterDef = <T>(key: ParameterKey): OptionsParameter<T> => {
  const parameterDef = getParameterDef(key);

  if (parameterDef.kind !== "options") {
    throw new Error(`Parameter ${key} is not an options parameter.`);
  }
  return parameterDef as OptionsParameter<T>;
};

export const getStringParameterDef = (key: ParameterKey): StringParameter => {
  const parameterDef = getParameterDef(key);

  if (parameterDef.kind !== "string") {
    throw new Error(`Parameter ${key} is not a string parameter.`);
  }
  return parameterDef as StringParameter;
};

export const getFileParameterDef = (key: ParameterKey): FileParameter => {
  const parameterDef = getParameterDef(key);

  if (parameterDef.kind !== "file") {
    throw new Error(`Parameter ${key} is not a file parameter.`);
  }
  return parameterDef as FileParameter;
};

// --- Step Parameter Helpers ---

/** Returns all parameter keys where includeInStep is true */
export const getStepParameterKeys = (): ParameterKey[] => {
  return Object.entries(parameterDefs)
    .filter(([, def]) => def.includeInStep)
    .map(([key]) => key as ParameterKey);
};

/** Type for a brush step - contains only step-scoped parameters */
export type BrushStep = {
  id: string;
  name: string;
  color?: BrushColor;
  lockedOffset?: { beats: number; pitch: number } | null;
  sourceFile?: FileParameterValue;
} & {
  [K in Exclude<ParameterKey, "sourceFile">]?: (typeof parameterDefs)[K] extends { default: infer D } ? D : never;
};

/** Creates a default step with all step parameter defaults */
export const createDefaultStep = (name = "Step 1", color?: BrushColor): BrushStep => {
  const step: any = {
    id: crypto.randomUUID(),
    name,
  };
  if (color) step.color = color;
  for (const [key, def] of Object.entries(parameterDefs)) {
    if (def.includeInStep) {
      step[key as ParameterKey] = def.default;
    }
  }
  return step as BrushStep;
};

/** Check if a parameter key is a step parameter */
export const isStepParameter = (key: ParameterKey): boolean => {
  const def = parameterDefs[key];
  return def?.includeInStep === true;
};

// --- File Parameter Helpers ---

/** Returns all parameter keys with kind: "file". */
export const getFileParameterKeys = (): ParameterKey[] => {
  return Object.entries(parameterDefs)
    .filter(([, def]) => def.kind === "file")
    .map(([key]) => key as ParameterKey);
};

// --- Effect Parameter Helpers ---

/** Check if a parameter key belongs to an effect (has effectType set) */
export const isEffectParameter = (key: ParameterKey): boolean => {
  const def = parameterDefs[key];
  return def?.effectType !== undefined;
};

/** Get the effect type a parameter belongs to, or undefined if not an effect parameter */
export const getEffectType = (key: ParameterKey): EffectType | undefined => {
  const def = parameterDefs[key];
  return def?.effectType;
};

/** Get all parameter keys for a specific effect type */
export const getEffectParameterKeys = (effectType: EffectType): ParameterKey[] => {
  return Object.entries(parameterDefs)
    .filter(([, def]) => def.effectType === effectType)
    .map(([key]) => key as ParameterKey);
};

/** Get default parameter values for a specific effect type */
export const getEffectParameterDefaults = (effectType: EffectType): EffectParams => {
  const keys = getEffectParameterKeys(effectType);
  const defaults: EffectParams = {};
  for (const key of keys) {
    const def = parameterDefs[key];
    if (def) {
      defaults[key] = def.default;
    }
  }
  return defaults;
};
