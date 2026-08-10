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
  { name: "Fill", description: "Eight even stamps per bar", code: '"x*8"' },
  { name: "Offbeat", description: "On the off-eighths only", code: '"[~ x]*4"' },
  { name: "Euclid", description: "Three stamps spread over eight", code: '"x(3,8)"' },
  { name: "Build", description: "Euclidean density rising each bar", code: '"x(<3 5 7 8>,8)"' },
  { name: "Stutter", description: "Sixteenths, half of them dropped", code: '"x*16?"' },
  { name: "Sparse", description: "Five of sixteen, rotated and thinned", code: '"x(5,16,2)?"' },
  { name: "Reverse", description: "A rhythm played backwards", code: 'mini("x [x x] x x").rev()' },
  { name: "Every 4th", description: "Reversed once every fourth bar", code: 'mini("x*8").every(4, (p) => p.rev())' },
  { name: "Echo", description: "Each stamp answered a sixteenth later", code: 'mini("x ~ x ~").off(0.25, (p) => p)' },
  { name: "Widening", description: "Stamps of growing length", code: '"x@1 x@2 x@4"' },
];
