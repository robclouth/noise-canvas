import { BASE_HUES } from "./colors";

export const MULTIPLIER_UNIT = "x";

// Sentinel bottom position of the time-grid slider: below the smallest real
// beat value, the grid is the file's detected onsets instead of beats.
export const ONSETS_GRID_VALUE = 1 / 128;
export const DEFAULT_ONSET_SENSITIVITY = 50;

// Padding either side of a repainted span when its onsets are found again. An
// event is anchored at the foot of its attack and its level measured for a
// moment after it, so the ones at the edges of the span have to be read from a
// little more material than the span itself.
export const ONSET_REGION_PAD_SEC = 0.25;

// The time grid means onsets rather than beats whenever it sits below the
// smallest beat value.
export function isOnsetGrid(gridSizeBeats: number): boolean {
  return gridSizeBeats < BEAT_VALUES[0].value;
}

// Sentinel positions below the smallest real span on the controls that measure
// one out in beats or semitones — the modulator rates and the sequencer loops.
// A span set to one of these follows the grid cell or the brush instead of
// holding a fixed size. Matched exactly rather than as a band: every other value
// on those parameters is a real span.
export const GRID_SPAN_BEATS_VALUE = 1 / 256;
export const BRUSH_SPAN_BEATS_VALUE = 1 / 128;
export const GRID_SPAN_SEMIS_VALUE = 1 / 32;
export const BRUSH_SPAN_SEMIS_VALUE = 1 / 16;

/** True where a span in beats follows the time grid. */
export function isGridSpanBeats(beats: number): boolean {
  return beats === GRID_SPAN_BEATS_VALUE;
}

/** True where a span in beats follows the brush's width. */
export function isBrushSpanBeats(beats: number): boolean {
  return beats === BRUSH_SPAN_BEATS_VALUE;
}

/** True where a span in semitones follows the pitch grid. */
export function isGridSpanSemis(semis: number): boolean {
  return semis === GRID_SPAN_SEMIS_VALUE;
}

/** True where a span in semitones follows the brush's height. */
export function isBrushSpanSemis(semis: number): boolean {
  return semis === BRUSH_SPAN_SEMIS_VALUE;
}

// attractMap values at and above this read a modulator's precomputed field
// (3/4/5 = Modulator 1/2/3).
export const ATTRACT_MODULATOR_MAP_START = 3;

// Coefficient magnitude produced by a steady sine at full scale (amplitude 1.0).
// The analysis applies no amplitude normalization, so this factor is what relates
// a stored magnitude to an absolute level: amplitude = magnitude / this. It is
// independent of frequency — measured identical from 55 Hz to 7 kHz against the
// analysis parameters (overlap 0.7, global phase).
export const FULL_SCALE_MAGNITUDE = 0.45727;

// Decibel offset that converts a raw magnitude in dB to dBFS:
// dBFS = 20*log10(magnitude) + FULL_SCALE_DB_OFFSET.
export const FULL_SCALE_DB_OFFSET = -20 * Math.log10(FULL_SCALE_MAGNITUDE);

export const BEAT_VALUES = [
  { value: 1 / 64, label: "1/64" },
  { value: (1 / 32) * (2 / 3), label: "1/32t" },
  { value: 1 / 32, label: "1/32" },
  { value: 1 / 24, label: "1/16t" },
  { value: (1 / 32) * 1.5, label: "1/32d" },
  { value: 1 / 16, label: "1/16" },
  { value: 1 / 12, label: "1/8t" },
  { value: (1 / 16) * 1.5, label: "1/16d" },
  { value: 1 / 8, label: "1/8" },
  { value: 1 / 6, label: "1/4t" },
  { value: (1 / 8) * 1.5, label: "1/8d" },
  { value: 1 / 4, label: "1/4" },
  { value: 1 / 3, label: "1/2t" },
  { value: (1 / 4) * 1.5, label: "1/4d" },
  { value: 1 / 2, label: "1/2" },
  { value: 2 / 3, label: "1t" },
  { value: (1 / 2) * 1.5, label: "1/2d" },
  { value: 1, label: "1" },
  { value: 1.5, label: "1d" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 6, label: "6" },
  { value: 8, label: "8" },
  { value: 12, label: "12" },
  { value: 16, label: "16" },
  { value: 24, label: "24" },
  { value: 32, label: "32" },
];

export const PITCH_VALUES = [
  { value: 1 / 8, label: "1/8" },
  { value: 1 / 4, label: "1/4" },
  { value: 1 / 2, label: "1/2" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5" },
  { value: 6, label: "6" },
  { value: 7, label: "7" },
  { value: 8, label: "8" },
  { value: 9, label: "9" },
  { value: 10, label: "10" },
  { value: 11, label: "11" },
  { value: 12, label: "12" },
  { value: 18, label: "18" },
  { value: 24, label: "24" },
  { value: 36, label: "36" },
  { value: 48, label: "48" },
  { value: 60, label: "60" },
  { value: 72, label: "72" },
  { value: 84, label: "84" },
  { value: 96, label: "96" },
];

export const PITCH_VALUES_NO_FRACTIONS = PITCH_VALUES.filter((v) => v.value >= 1);

export const MULTIPLIER_VALUES = [
  { value: 1 / 128, label: "1/128" },
  { value: 1 / 64, label: "1/64" },
  { value: 1 / 32, label: "1/32" },
  { value: 1 / 16, label: "1/16" },
  { value: 1 / 8, label: "1/8" },
  { value: 1 / 4, label: "1/4" },
  { value: 1 / 3, label: "1/3" },
  { value: 1 / 2, label: "1/2" },
  { value: 2 / 3, label: "2/3" },
  { value: 3 / 4, label: "3/4" },
  { value: 1, label: "1" },
  { value: 1.5, label: "1.5" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 6, label: "6" },
  { value: 8, label: "8" },
  { value: 12, label: "12" },
  { value: 16, label: "16" },
  { value: 24, label: "24" },
  { value: 32, label: "32" },
  { value: 48, label: "48" },
  { value: 64, label: "64" },
  { value: 96, label: "96" },
  { value: 128, label: "128" },
  { value: 192, label: "192" },
  { value: 256, label: "256" },
];

export const BANDS_PER_OCTAVE_VALUES = [
  { value: 12, label: "Best Time" },
  { value: 24, label: "Better Time" },
  { value: 36, label: "Balanced" },
  { value: 48, label: "Better Pitch" },
  { value: 60, label: "Best Pitch" },
];

export const BLEND_MODES = [
  { value: 0, label: "Mix" },
  { value: 1, label: "Add" },
  { value: 2, label: "Subtract" },
  { value: 3, label: "Multiply" },
  { value: 4, label: "Divide" },
  { value: 5, label: "Maximum" },
  { value: 6, label: "Minimum" },
  { value: 7, label: "Difference" },
  { value: 8, label: "Dissolve" },
  { value: 9, label: "Mask" },
  { value: 10, label: "Screen" },
];

export const MODULATOR_MODES = [
  { value: 0, label: "Pattern" },
  { value: 1, label: "Envelope" },
  { value: 2, label: "Sequence" },
];

// Sequencer constants (using DataTexture so no uniform limit issues)
export const MAX_SEQ_STEPS_X = 16;
export const MAX_SEQ_STEPS_Y = 16;
export const MAX_SEQ_SIZE = MAX_SEQ_STEPS_X * MAX_SEQ_STEPS_Y;

export const PATTERN_SHAPES = [
  { value: 0, label: "Sine" },
  { value: 1, label: "Triangle" },
  { value: 2, label: "Square" },
  { value: 3, label: "Sawtooth" },
  { value: 4, label: "Pulse" },
  { value: 5, label: "Random" },
  { value: 6, label: "Smooth Noise" },
  { value: 13, label: "Quilt" },
  { value: 14, label: "Clouds" },
  { value: 15, label: "Cells" },
  { value: 16, label: "Bubbles" },
  { value: 17, label: "Craters" },
  { value: 18, label: "Ripples" },
  { value: 19, label: "Scratches" },
  { value: 20, label: "Swirls" },
  { value: 21, label: "Paper" },
  { value: 22, label: "Marble" },
  { value: 23, label: "Weave" },
  { value: 24, label: "Terrain" },
  { value: 25, label: "Flow" },
  { value: 11, label: "Selected Scale" },
  // Note: value 12 is reserved for "Image" mode (handled separately in UI)
];

export const EDGE_MODE = [
  { value: 0, label: "Cut" },
  { value: 1, label: "Bleed" },
  { value: 2, label: "Wrap" },
  { value: 3, label: "Clamp" },
  { value: 4, label: "Reflect" },
  { value: 5, label: "Invert" },
];

export const SYNTHESIZE_TYPES = [
  { value: 0, label: "Noise" },
  { value: 1, label: "Sine" },
  { value: 2, label: "Impulse" },
];

export const WRAP_MODES = [
  { value: 0, label: "Off" },
  { value: 1, label: "Time" },
  { value: 2, label: "Pitch" },
  { value: 3, label: "Time & Pitch" },
];

export const BRUSH_ANCHOR_MODES = [
  { value: 0, label: "Corner" },
  { value: 1, label: "Centre" },
];

export const BRUSH_ANCHOR_MODE_CORNER = 0;
export const BRUSH_ANCHOR_MODE_CENTER = 1;

export const NUM_MODULATORS = 3;

export const NUM_MACROS = 4;

// Contextual modulation sources - stroke properties that can modulate parameters
export const CONTEXTUAL_MOD_SOURCES = [
  { key: "Iteration", label: "Iteration", description: "Iteration index (0-1 across brush iterations)" },
  { key: "Time", label: "Time Pos.", description: "Time position (0-1 across file duration)" },
  { key: "Pitch", label: "Pitch Pos.", description: "Pitch position (0-1 across frequency range)" },
  { key: "Random", label: "Randomise", description: "Random value per stroke (0-1)" },
  { key: "Step", label: "Step", description: "Step index (0-1 across steps)" },
  { key: "Pressure", label: "Pressure", description: "Pen pressure (0-1)" },
  { key: "TiltX", label: "Tilt X", description: "Pen tilt X (0-1, centre=0.5)" },
  { key: "TiltY", label: "Tilt Y", description: "Pen tilt Y (0-1, centre=0.5)" },
] as const;
export const NUM_CONTEXTUAL_MOD_SOURCES = CONTEXTUAL_MOD_SOURCES.length;

// The faithful rule, re-anchoring phase at detected onsets so transients
// survive being moved. Needs the source onset map (see onset-map.ts).
export const NEUTRAL_ALGORITHM = 6;

export const ALGORITHMS = [
  {
    value: NEUTRAL_ALGORITHM,
    label: "Sharp",
    group: "Natural",
    description: "Default. Best on drums and most sounds.",
  },
  {
    value: 3,
    label: "Soft",
    group: "Natural",
    description: "Best on sustained, non-percussive sounds.",
  },
  {
    value: 2,
    label: "Locked",
    group: "Coloured",
    description: "Hard and robotic, pinned in place.",
  },
  {
    value: 0,
    label: "Flangey",
    group: "Coloured",
    description: "Hollow and metallic, like a comb filter.",
  },
  {
    value: 1,
    label: "Noisey",
    group: "Coloured",
    description: "Diffuse and breathy, edges blurred away.",
  },
];

const [HUE_GRAPE, HUE_RED, , HUE_GREEN, HUE_VIOLET, HUE_CYAN, HUE_PINK, HUE_ORANGE, HUE_INDIGO, HUE_TEAL] = BASE_HUES;

export const EFFECT_COLORS: Record<string, string> = {
  dynamics: HUE_GRAPE,
  transform: HUE_RED,
  blur: HUE_GREEN,
  clone: "lime",
  synthesize: HUE_VIOLET,
  evolve: HUE_CYAN,
  binaural: HUE_PINK,
  sort: HUE_ORANGE,
  transmute: HUE_INDIGO,
  waveshape: HUE_TEAL,
  convolve: "blue",
  align: "gray",
  attract: "lime",
};

export const EFFECT_LABELS: Record<string, string> = {
  dynamics: "Dynamics",
  transform: "Transform",
  blur: "Blur",
  clone: "Repeat",
  synthesize: "Synthesise",
  evolve: "Evolve",
  binaural: "Binaural",
  sort: "Sort",
  transmute: "Transmute",
  waveshape: "Waveshape",
  convolve: "Convolve",
  align: "Align",
  attract: "Attract",
};

// Read at the moment of choosing, by someone who does not yet know what the
// effect is: one sentence in two clauses, the operation first and the sound it
// produces second. Modes and mechanism belong in the manual.
export const EFFECT_DESCRIPTIONS: Record<string, string> = {
  dynamics: "Compresses, gates, expands or inverts each band, into chopped and hollow sound.",
  transform: "Slides, stretches and rotates the sound through time and pitch, or reverses it.",
  blur: "Smears energy across time and pitch, into reverb tails, freezes and soft edges.",
  clone: "Copies the sound at beat and semitone offsets, into echoes and stacked chords.",
  synthesize: "Fills the brushed area with noise, tones or impulses: sound out of nothing.",
  evolve: "Grows, spreads and decays the sound on its own, into fluid, unpredictable life.",
  binaural: "Places the sound around the listener's head: left, right, close, far, behind.",
  sort: "Reorders the bands by loudness or phase, banking them into glitched stripes.",
  transmute: "Turns one part of the sound into another: level into pitch, phase into pan.",
  waveshape: "Distorts the spectrum itself, into clipped, folded and wrapped tones.",
  convolve: "Prints another sound's character onto this one: rooms, plates, resonant junk.",
  align: "Snaps everything into one sharp impulse, then lets it drift apart again.",
  attract: "Pulls energy onto a map of valleys, gathering smear into notes and hits.",
};
