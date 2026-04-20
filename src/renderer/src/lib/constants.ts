import { BASE_HUES } from "./colors";

export const BEAT_UNIT = " b";
export const SEMITONE_UNIT = " st";
export const MULTIPLIER_UNIT = "x";

export const BEAT_VALUES = [
  { value: 1 / 64, label: "1/64" },
  { value: (1 / 32) * (2 / 3), label: "1/32t" },
  { value: 1 / 32, label: "1/32" },
  { value: (1 / 32) * 1.5, label: "1/32d" },
  { value: 1 / 24, label: "1/16t" },
  { value: 1 / 16, label: "1/16" },
  { value: (1 / 16) * 1.5, label: "1/16d" },
  { value: 1 / 12, label: "1/8t" },
  { value: 1 / 8, label: "1/8" },
  { value: (1 / 8) * 1.5, label: "1/8d" },
  { value: 1 / 6, label: "1/4t" },
  { value: 1 / 4, label: "1/4" },
  { value: (1 / 4) * 1.5, label: "1/4d" },
  { value: 1 / 3, label: "1/2t" },
  { value: 1 / 2, label: "1/2" },
  { value: (1 / 2) * 1.5, label: "1/2d" },
  { value: 2 / 3, label: "1t" },
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
].sort((a, b) => a.value - b.value);

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
  { value: 2, label: "Sequencer" },
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
  // { value: 7, label: "Cloud Noise" },
  // { value: 8, label: "Glass Noise" },
  // { value: 9, label: "Ghost Noise" },
  // { value: 10, label: "Bubble Noise" },
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
];

export const WRAP_MODES = [
  { value: 0, label: "Off" },
  { value: 1, label: "Time" },
  { value: 2, label: "Pitch" },
  { value: 3, label: "Time & Pitch" },
];

export const BRUSH_ANCHOR_MODES = [
  { value: 0, label: "Corner" },
  { value: 1, label: "Center" },
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
  { key: "Random", label: "Randomize", description: "Random value per stroke (0-1)" },
  { key: "Step", label: "Step", description: "Step index (0-1 across steps)" },
  { key: "Pressure", label: "Pressure", description: "Pen pressure (0-1)" },
  { key: "TiltX", label: "Tilt X", description: "Pen tilt X (0-1, center=0.5)" },
  { key: "TiltY", label: "Tilt Y", description: "Pen tilt Y (0-1, center=0.5)" },
] as const;
export const NUM_CONTEXTUAL_MOD_SOURCES = CONTEXTUAL_MOD_SOURCES.length;

export const ALGORITHMS = [
  { value: 4, label: "Neutral" },
  { value: 3, label: "Neutralish" },
  { value: 2, label: "Percussive" },
  { value: 0, label: "Flangey" },
  { value: 1, label: "Noisey" },
];

const [HUE_GRAPE, HUE_RED, HUE_YELLOW, HUE_GREEN, HUE_VIOLET, HUE_CYAN, HUE_PINK, HUE_ORANGE, HUE_INDIGO, HUE_TEAL] =
  BASE_HUES;

export const EFFECT_COLORS: Record<string, string> = {
  dynamics: HUE_GRAPE,
  transform: HUE_RED,
  overtones: HUE_YELLOW,
  blur: HUE_GREEN,
  clone: "lime",
  synthesize: HUE_VIOLET,
  evolve: HUE_CYAN,
  binaural: HUE_PINK,
  sort: HUE_ORANGE,
  transmute: HUE_INDIGO,
  waveshape: HUE_TEAL,
  convolve: "blue",
};

export const EFFECT_LABELS: Record<string, string> = {
  dynamics: "Dynamics",
  transform: "Transform",
  overtones: "Overtones",
  blur: "Blur",
  clone: "Clone",
  synthesize: "Synthesize",
  evolve: "Evolve",
  binaural: "Binaural",
  sort: "Sort",
  transmute: "Transmute",
  waveshape: "Waveshape",
  convolve: "Convolve",
};

export const EFFECT_DESCRIPTIONS: Record<string, string> = {
  dynamics: "Control dynamic range with compression, expansion, gating, and inversion.",
  transform: "Shift, scale, and rotate the spectrogram content in time and frequency.",
  overtones: "Add overtones to create richer timbres.",
  blur: "Smooth and blend frequencies over time and pitch for softer transitions.",
  clone:
    "Stamp beat- and semitone-spaced copies in 2D for echoes, harmonics, and fractal subdivisions when modulated by iteration.",
  synthesize: "Generate new audio content from scratch (noise, sine waves, etc.).",
  evolve: "Reaction-advection-diffusion simulation for fluid, biological, and chaotic patterns.",
  binaural: "HRTF-based binaural spatialization for 3D audio positioning.",
  sort: "Odd-even transposition sort on spectrogram bins by magnitude or phase.",
  transmute:
    "Low-level polar operations on raw magnitude and phase: swap, complex power, phase rotate, quantize, stereo cross, and phase gate.",
  waveshape:
    "Waveshaper distortion on rectangular spectral bins: soft clip, hard clip, rectify, and boundary modes (fold, wrap, invert, cut).",
  convolve:
    "Time-axis convolution with an IR spectrogram. Reverbs, room tones, and other impulse-response-based effects.",
};
