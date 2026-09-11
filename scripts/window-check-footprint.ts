import { snapToSwungGridFloor } from "../src/renderer/src/lib/utils";

export const fixture = { seconds: 60, sampleRate: 44100, bpm: 120, gridBeats: 1, brushBeats: 1 };
export const drag = { from: 0.08, to: 0.92, steps: 24, returnTo: 0.03 };
export const scriptedPositions = [
  drag.from,
  ...Array.from({ length: drag.steps }, (_, i) => drag.from + ((drag.to - drag.from) * (i + 1)) / drag.steps),
  drag.returnTo,
];

export interface TimeSpan {
  timeMin: number;
  timeMax: number;
}

export interface StrokeFootprint {
  ranges: number;
  pixels: number;
  line: string;
  bounds: TimeSpan | null;
}

/** The file-time span of the fixture's snapped, corner-anchored dabs. */
export function expectedStrokeSpan(positions: readonly number[] = scriptedPositions): TimeSpan {
  const beats = (fixture.seconds * fixture.bpm) / 60;
  const starts = positions.map((position) => snapToSwungGridFloor(position * beats, fixture.gridBeats, 0) / beats);
  return { timeMin: Math.min(...starts), timeMax: Math.max(...starts) + fixture.brushBeats / beats };
}

/** Reads each committed footprint with its preceding file-time bounds diagnostic. */
export function committedFootprints(logs: readonly string[]): StrokeFootprint[] {
  const footprints: StrokeFootprint[] = [];
  let bounds: TimeSpan | null = null;
  for (const line of logs) {
    if (line.includes("addStroke footprint time bounds")) {
      const match = /timeMin: ([\d.eE+-]+), timeMax: ([\d.eE+-]+)/.exec(line);
      bounds = match ? { timeMin: Number(match[1]), timeMax: Number(match[2]) } : null;
    }
    const match = /addStroke footprint delta.*?ranges: (\d+), footprintPixels: (\d+)/.exec(line);
    if (!match) continue;
    footprints.push({ ranges: Number(match[1]), pixels: Number(match[2]), line, bounds });
    bounds = null;
  }
  return footprints;
}

/** Reports the ends of the scripted span absent from a committed footprint. */
export function strokeSpanFailure(footprint: StrokeFootprint, expected = expectedStrokeSpan()): string | null {
  const bounds = footprint.bounds;
  if (
    !bounds ||
    !Number.isFinite(bounds.timeMin) ||
    !Number.isFinite(bounds.timeMax) ||
    bounds.timeMax <= bounds.timeMin
  ) {
    return "the commit has no valid time bounds; scripted stroke coverage is unknown";
  }
  const missing: string[] = [];
  if (bounds.timeMin > expected.timeMin) missing.push(`left end (${bounds.timeMin} > ${expected.timeMin})`);
  if (bounds.timeMax < expected.timeMax) missing.push(`right end (${bounds.timeMax} < ${expected.timeMax})`);
  return missing.length
    ? `the scripted stroke is incomplete: missing ${missing.join(" and ")}; comparison is inconclusive`
    : null;
}
