export const BEAT_VALUES = [
  { value: 1 / 64, label: "1/64 beats" },
  { value: 1 / 32, label: "1/32 beats" },
  { value: 1 / 16, label: "1/16 beats" },
  { value: 1 / 8, label: "1/8 beats" },
  { value: 1 / 4, label: "1/4 beats" },
  { value: 1 / 2, label: "1/2 beats" },
  { value: 1, label: "1 beats" },
  { value: 2, label: "2 beats" },
  { value: 3, label: "3 beats" },
  { value: 4, label: "4 beats" },
  { value: 6, label: "6 beats" },
  { value: 8, label: "8 beats" },
  { value: 12, label: "12 beats" },
  { value: 16, label: "16 beats" },
  { value: 24, label: "24 beats" },
  { value: 32, label: "32 beats" },
];

export const PITCH_VALUES = [
  { value: 1, label: "1 semi" },
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

export const MODULATOR_MODE = {
  LFO: 0,
} as const;

export const PATTERN_SHAPE = {
  SINE: 0,
  TRIANGLE: 1,
  SQUARE: 2,
  SAWTOOTH: 3,
  PULSE: 4,
  RANDOM: 5,
} as const;
