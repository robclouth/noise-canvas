/** Tap spacing tables for the repeat effect, in unit steps of the axis Gap value. */
export type CloneShapeKey = "even" | "harmonic" | "geometric" | "inharmonic" | "scale";

export interface CloneShape {
  /** Label on the pitch axis. */
  label: string;
  /** Label on the time axis. Null keeps the shape off the time axis. */
  timeLabel: string | null;
  create: (count: number) => number[];
}

// Highest exponent the geometric table reaches before it flattens, so a large
// count cannot produce Infinity.
const MAX_GEOMETRIC_EXPONENT = 24;

// Stiffness term for the inharmonic table. Roughly piano-like: the 32nd partial
// lands about a quarter of an octave sharp.
const STIFFNESS = 0.0004;

/** Shifts the table to start at 0 and scales it so the first copy sits one step out. */
function normalize(values: number[]): number[] {
  const shifted = values.map((v) => v - values[0]);
  const unit = shifted.length > 1 ? shifted[1] : 0;
  if (Math.abs(unit) < 1e-9) return shifted;
  return shifted.map((v) => v / unit);
}

export const cloneShapes: Record<CloneShapeKey, CloneShape> = {
  even: {
    label: "Even",
    timeLabel: "Even",
    create: (count) => Array.from({ length: count }, (_, i) => i),
  },
  harmonic: {
    label: "Harmonic",
    timeLabel: "Decelerating",
    create: (count) => Array.from({ length: count }, (_, i) => Math.log2(i + 1)),
  },
  geometric: {
    label: "Geometric",
    timeLabel: "Accelerating",
    create: (count) => Array.from({ length: count }, (_, i) => Math.pow(2, Math.min(i, MAX_GEOMETRIC_EXPONENT)) - 1),
  },
  inharmonic: {
    label: "Inharmonic",
    timeLabel: "Uneven",
    create: (count) =>
      normalize(
        Array.from({ length: count }, (_, i) => {
          const partial = i + 1;
          return Math.log2(partial * Math.sqrt(1 + STIFFNESS * partial * partial));
        }),
      ),
  },
  // Even steps; the shader snaps each copy's landing pitch to the selected scale.
  scale: {
    label: "Scale",
    timeLabel: null,
    create: (count) => Array.from({ length: count }, (_, i) => i),
  },
};

export const CLONE_SHAPE_KEYS = Object.keys(cloneShapes) as CloneShapeKey[];

/**
 * Pass indices the repeat effect renders: 0 is the time axis, 1 is the pitch axis.
 * Counts are copies added on top of the original. An axis adding none has
 * nothing to do, but one pass always runs because it stamps the source and
 * applies the edge mode.
 */
export function activeClonePasses(countX: number, countY: number): number[] {
  const passes: number[] = [];
  if (countX > 0) passes.push(0);
  if (countY > 0) passes.push(1);
  return passes.length > 0 ? passes : [0];
}

/** Tap offsets in unit steps, where 1 step is one axis Gap value. */
export function buildShapeTable(shapeKey: CloneShapeKey, count: number): number[] {
  const shape = cloneShapes[shapeKey] ?? cloneShapes.even;
  return shape.create(Math.max(1, count));
}
