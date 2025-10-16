export const BEAT_VALUES = [
  { value: 1 / 64, label: "1/64 beat" },
  { value: (1 / 32) * (2 / 3), label: "1/32t beat" },
  { value: 1 / 32, label: "1/32 beat" },
  { value: (1 / 32) * 1.5, label: "1/32d" },
  { value: 1 / 24, label: "1/16t beat" },
  { value: 1 / 16, label: "1/16 beat" },
  { value: (1 / 16) * 1.5, label: "1/16d beat" },
  { value: 1 / 12, label: "1/8t beat" },
  { value: 1 / 8, label: "1/8 beat" },
  { value: (1 / 8) * 1.5, label: "1/8d beat" },
  { value: 1 / 6, label: "1/4t beat" },
  { value: 1 / 4, label: "1/4 beat" },
  { value: (1 / 4) * 1.5, label: "1/4d beat" },
  { value: 1 / 3, label: "1/2t beat" },
  { value: 1 / 2, label: "1/2 beat" },
  { value: (1 / 2) * 1.5, label: "1/2d beat" },
  { value: 2 / 3, label: "1t beat" },
  { value: 1, label: "1 beat" },
  { value: 1.5, label: "1d beat" },
  { value: 2, label: "2 beats" },
  { value: 3, label: "3 beats" },
  { value: 4, label: "4 beats" },
  { value: 6, label: "6 beats" },
  { value: 8, label: "8 beats" },
  { value: 12, label: "12 beats" },
  { value: 16, label: "16 beats" },
  { value: 24, label: "24 beats" },
  { value: 32, label: "32 beats" },
].sort((a, b) => a.value - b.value);

export const PITCH_VALUES = [
  { value: 1 / 8, label: "1/8 semi" },
  { value: 1 / 4, label: "1/4 semi" },
  { value: 1 / 2, label: "1/2 semi" },
  { value: 1, label: "1 semis" },
  { value: 2, label: "2 semis" },
  { value: 3, label: "3 semis" },
  { value: 4, label: "4 semis" },
  { value: 5, label: "5 semis" },
  { value: 6, label: "6 semis" },
  { value: 7, label: "7 semis" },
  { value: 8, label: "8 semis" },
  { value: 9, label: "9 semis" },
  { value: 10, label: "10 semis" },
  { value: 11, label: "11 semis" },
  { value: 12, label: "12 semis" },
  { value: 18, label: "18 semis" },
  { value: 24, label: "24 semis" },
  { value: 36, label: "36 semis" },
  { value: 48, label: "48 semis" },
  { value: 60, label: "60 semis" },
  { value: 72, label: "72 semis" },
  { value: 84, label: "84 semis" },
  { value: 96, label: "96 semis" },
];

export const PITCH_VALUES_NO_FRACTIONS = PITCH_VALUES.filter((v) => v.value >= 1);

export const MULTIPLIER_VALUES = [
  { value: 1 / 128, label: "x 1/128" },
  { value: 1 / 64, label: "x 1/64" },
  { value: 1 / 32, label: "x 1/32" },
  { value: 1 / 16, label: "x 1/16" },
  { value: 1 / 8, label: "x 1/8" },
  { value: 1 / 4, label: "x 1/4" },
  { value: 1 / 3, label: "x 1/3" },
  { value: 1 / 2, label: "x 1/2" },
  { value: 2 / 3, label: "x 2/3" },
  { value: 3 / 4, label: "x 3/4" },
  { value: 1, label: "x 1" },
  { value: 1.5, label: "x 1.5" },
  { value: 2, label: "x 2" },
  { value: 3, label: "x 3" },
  { value: 4, label: "x 4" },
  { value: 6, label: "x 6" },
  { value: 8, label: "x 8" },
  { value: 12, label: "x 12" },
  { value: 16, label: "x 16" },
  { value: 24, label: "x 24" },
  { value: 32, label: "x 32" },
  { value: 48, label: "x 48" },
  { value: 64, label: "x 64" },
  { value: 96, label: "x 96" },
  { value: 128, label: "x 128" },
  { value: 192, label: "x 192" },
  { value: 256, label: "x 256" },
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
];

export const MODULATOR_MODES = [
  { value: 0, label: "Pattern" },
  { value: 1, label: "Envelope Follower" },
];

export const PATTERN_SHAPES = [
  { value: 0, label: "Sine" },
  { value: 1, label: "Triangle" },
  { value: 2, label: "Square" },
  { value: 3, label: "Sawtooth" },
  { value: 4, label: "Pulse" },
  { value: 5, label: "Random" },
  { value: 6, label: "Smooth Noise" },
  { value: 7, label: "Cloud Noise" },
  { value: 8, label: "Glass Noise" },
  { value: 9, label: "Ghost Noise" },
  { value: 10, label: "Bubble Noise" },
  { value: 11, label: "Selected Scale" },
  // Note: value 12 is reserved for "Image" mode (handled separately in UI)
];

export const EDGE_MODE = [
  { value: 0, label: "Cut" },
  { value: 1, label: "Bleed" },
  { value: 2, label: "Wrap" },
  { value: 3, label: "Mirror" },
];

export const SYNTHESIZE_TYPES = [
  { value: 0, label: "Noise" },
  { value: 1, label: "Sine" },
];

export const WRAP_MODES = [
  { value: 0, label: "Off" },
  { value: 1, label: "X" },
  { value: 2, label: "Y" },
  { value: 3, label: "X & Y" },
];

export const NUM_MODULATORS = 3;

export const ALGORITHMS = [
  { value: 0, label: "Resonant" },
  { value: 1, label: "Noise" },
  { value: 2, label: "Snappy" },
];
