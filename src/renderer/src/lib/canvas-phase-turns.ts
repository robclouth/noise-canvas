import type { PhaseTurns } from "../../../main/lib/types";
import { phaseTurnRanges } from "../../../main/lib/history-delta";
import { mergePixelRanges } from "./pixel-ranges";

/** What applying a turn to the canvas needs of the renderer. */
export interface PhaseTurnCanvas {
  applyPhaseTurns: (turns: ArrayLike<number>) => void;
  readPixelRanges: (pixelRanges: Uint32Array) => Promise<Float32Array>;
  patchFBOData: (data: Float32Array, pixelRanges: Uint32Array) => void;
}

/** A turn to put on the canvas, subtracted when it is being undone. */
export interface CanvasTurn {
  turns: PhaseTurns;
  invert: boolean;
}

/**
 * The renderer's flat [pixelStart, pixelCount, offsetLeft, offsetRight, ...]
 * list for a turn, signed for its direction.
 */
export function flattenPhaseTurns(turn: CanvasTurn): number[] {
  const out: number[] = [];
  const { turns, invert } = turn;
  for (let i = 0; i < turns.pixelStarts.length; i++) {
    const c0 = invert ? -turns.offsets[i * 2] : turns.offsets[i * 2];
    const c1 = invert ? -turns.offsets[i * 2 + 1] : turns.offsets[i * 2 + 1];
    out.push(turns.pixelStarts[i], turns.pixelCounts[i], c0, c1);
  }
  return out;
}

/**
 * Sample pixels spread over the ranges, as single-pixel ranges in ascending
 * order, skipping any that fall inside `except`.
 */
export function samplePixelRanges(ranges: Uint32Array, count: number, except?: Uint32Array): Uint32Array {
  let total = 0;
  for (let i = 1; i < ranges.length; i += 2) total += ranges[i];
  if (total === 0) return new Uint32Array(0);
  const picks = new Set<number>();
  const n = Math.min(count, total);
  for (let s = 0; s < n; s++) {
    let target = Math.floor(((s + 0.5) / n) * total);
    for (let i = 0; i + 1 < ranges.length; i += 2) {
      if (target < ranges[i + 1]) {
        const p = ranges[i] + target;
        if (!except || !pixelInRanges(p, except)) picks.add(p);
        break;
      }
      target -= ranges[i + 1];
    }
  }
  const sorted = [...picks].sort((a, b) => a - b);
  const out = new Uint32Array(sorted.length * 2);
  sorted.forEach((p, i) => {
    out[i * 2] = p;
    out[i * 2 + 1] = 1;
  });
  return out;
}

function pixelInRanges(pixel: number, ranges: Uint32Array): boolean {
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    if (pixel >= ranges[i] && pixel < ranges[i] + ranges[i + 1]) return true;
  }
  return false;
}

/**
 * Whether the renderer's phase-turn pass adds floats exactly as the CPU does,
 * learned from the first turn put on a canvas and kept for the process, since
 * every canvas draws on the same GPU.
 */
let canvasAddsExactly: boolean | null = null;

/** Forgets the GPU verdict so the next turn checks again. */
export function resetCanvasTurnVerdict(): void {
  canvasAddsExactly = null;
}

/**
 * Puts turns on the canvas in order as GPU operations. `except` pixels are
 * ones a patch writes afterwards, so their turned values do not matter. The
 * process's first turn has a sample of its pixels read back and compared with
 * the packed state they must now equal; a GPU whose float add differs from the
 * CPU's gets the turned ranges uploaded from the packed state instead, now and
 * on every later call. Resolves once the canvas holds the state.
 */
export async function applyCanvasTurns(
  canvas: PhaseTurnCanvas,
  packed: Float32Array,
  turns: CanvasTurn[],
  except?: Uint32Array,
): Promise<void> {
  let all: Uint32Array = new Uint32Array(0);
  for (const turn of turns) {
    const flat = flattenPhaseTurns(turn);
    if (!flat.length) continue;
    if (canvasAddsExactly !== false) canvas.applyPhaseTurns(flat);
    all = mergePixelRanges(all, phaseTurnRanges(turn.turns));
  }
  if (!all.length) return;
  if (canvasAddsExactly === false) {
    canvas.patchFBOData(packed, all);
    return;
  }
  if (canvasAddsExactly === true) return;

  const sample = samplePixelRanges(all, 64, except);
  if (!sample.length) return;
  const read = await canvas.readPixelRanges(sample);
  let exact = true;
  for (let i = 0; i + 1 < sample.length && exact; i += 2) {
    const p = sample[i];
    const at = (i / 2) * 4;
    for (let c = 0; c < 4; c++) {
      const got = read[at + c];
      const want = packed[p * 4 + c];
      if (got !== want && !(Number.isNaN(got) && Number.isNaN(want))) {
        exact = false;
        break;
      }
    }
  }
  canvasAddsExactly = exact;
  if (!exact) {
    console.warn("history: the canvas does not take phase turns exactly; uploading turned pixels instead");
    canvas.patchFBOData(packed, all);
  }
}
