export interface GeneratePreset {
  name: string;
  description: string;
  code: string;
}

/**
 * Every preset stamps the token `x`, which resolves to no brush and therefore
 * falls back to the active one — so each of these runs on any palette.
 */
export const GENERATE_PRESETS: GeneratePreset[] = [
  { name: "Fill", description: "Eight even strokes per bar", code: '"x*8"' },
  { name: "Offbeat", description: "On the off-eighths only", code: '"[~ x]*4"' },
  { name: "Euclid", description: "Three strokes spread over eight", code: '"x(3,8)"' },
  { name: "Build", description: "Euclidean density rising each bar", code: '"x(<3 5 7 8>,8)"' },
  { name: "Stutter", description: "Sixteenths, half of them dropped", code: '"x*16?"' },
  { name: "Sparse", description: "Five of sixteen, rotated and thinned", code: '"x(5,16,2)?"' },
  { name: "Reverse", description: "A rhythm played backwards", code: 'mini("x [x x] x x").rev()' },
  { name: "Every 4th", description: "Reversed once every fourth bar", code: 'mini("x*8").every(4, (p) => p.rev())' },
  { name: "Echo", description: "Each stroke answered a sixteenth later", code: 'mini("x ~ x ~").off(0.25, (p) => p)' },
  { name: "Widening", description: "Strokes of growing length", code: '"x@1 x@2 x@4"' },
  { name: "Swell", description: "Strength rising across each bar", code: 's("x*8").gain(saw.segment(8))' },
  { name: "Climb", description: "A line walking up and back down", code: 's("x*8").n("0 3 5 7 12 7 5 3")' },
  {
    name: "Chord",
    description: "Three fixed pitches at once",
    code: 'stack(s("x*2").note("c3"), s("x*2").note("g3"), s("x*2").note("c4"))',
  },
  { name: "Bands", description: "Strokes of growing height", code: 's("x*4").height("6 12 24 48")' },
  { name: "Quarters", description: "The spectrum in four, bottom to top", code: 's("x*4").zone("0 1 2 3")' },
  { name: "Thirds up", description: "The spectrum in three, climbing", code: 's("x*6").zone("<0 1 2>")' },
  { name: "Split ends", description: "Lowest and highest of eight slices", code: 's("x*4").zone("0 7").zones(8)' },
  { name: "Scatter", description: "A random slice of sixteen each time", code: 's("x*8").zone(irand(16)).zones(16)' },
  { name: "Macro sweep", description: "Macro 1 swept across the file", code: 's("x*16").m1(sine.segment(16))' },
];
