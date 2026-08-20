import type { PhaseTurns } from "./types";

// Set on the range count when a delta carries a phase-turn section.
const TURNS_FLAG = 0x80000000;

/** Four floats per packed pixel: [magL, phaseL, magR, phaseR]. */
const FLOATS_PER_PIXEL = 4;

/** Whether a set of turns shifts anything at all. */
export function hasPhaseTurns(turns: PhaseTurns | null | undefined): turns is PhaseTurns {
  return turns != null && turns.pixelStarts.length > 0;
}

/**
 * Reads the phase turns out of a decompressed delta, laid out as
 * [u32 flags|rangeCount][ranges][u32 turnCount][turns: start, count, offset0,
 * offset1][u32 residualCount][residuals: index, bits][differences]. Null when
 * the delta predates turns.
 */
export function parseHistoryDeltaTurns(delta: Uint8Array): PhaseTurns | null {
  if (delta.byteLength < 4) return null;
  const view = new DataView(delta.buffer, delta.byteOffset, delta.byteLength);
  const header = view.getUint32(0, true);
  if ((header & TURNS_FLAG) === 0) return null;
  const rangeCount = header & ~TURNS_FLAG;
  let at = 4 + rangeCount * 8;
  if (at + 4 > delta.byteLength) return null;
  const turnCount = view.getUint32(at, true);
  at += 4;
  if (at + turnCount * 16 > delta.byteLength) return null;
  const pixelStarts = new Uint32Array(turnCount);
  const pixelCounts = new Uint32Array(turnCount);
  const offsets = new Float32Array(turnCount * 2);
  for (let i = 0; i < turnCount; i++) {
    pixelStarts[i] = view.getUint32(at, true);
    pixelCounts[i] = view.getUint32(at + 4, true);
    offsets[i * 2] = view.getFloat32(at + 8, true);
    offsets[i * 2 + 1] = view.getFloat32(at + 12, true);
    at += 16;
  }
  if (at + 4 > delta.byteLength) return null;
  const residualCount = view.getUint32(at, true);
  at += 4;
  if (at + residualCount * 8 > delta.byteLength) return null;
  const residuals = new Uint32Array(residualCount * 2);
  for (let i = 0; i < residuals.length; i++) residuals[i] = view.getUint32(at + i * 4, true);
  return { pixelStarts, pixelCounts, offsets, residuals };
}

/**
 * Adds (or, inverted, subtracts) the turns' offsets to the phases of a packed
 * state in place, the same float arithmetic the addon and the GPU use. Inverting
 * puts the residual floats back afterwards, so the state returns bit for bit.
 */
export function applyPhaseTurns(data: Float32Array, turns: PhaseTurns, invert: boolean): void {
  for (let i = 0; i < turns.pixelStarts.length; i++) {
    const start = turns.pixelStarts[i];
    const count = turns.pixelCounts[i];
    for (let ch = 0; ch < 2; ch++) {
      const c = invert ? -turns.offsets[i * 2 + ch] : turns.offsets[i * 2 + ch];
      if (c === 0) continue;
      let at = start * FLOATS_PER_PIXEL + ch * 2 + 1;
      const end = Math.min(data.length, (start + count) * FLOATS_PER_PIXEL);
      for (; at < end; at += FLOATS_PER_PIXEL) data[at] = Math.fround(data[at] + c);
    }
  }
  if (invert) {
    const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
    for (let i = 0; i + 1 < turns.residuals.length; i += 2) {
      if (turns.residuals[i] < bits.length) bits[turns.residuals[i]] = turns.residuals[i + 1];
    }
  }
}

/** The residual floats' pixels as a flat [pixelStart, pixelCount, ...] list, one pixel each. */
export function phaseTurnResidualRanges(turns: PhaseTurns): Uint32Array {
  const pixels = new Set<number>();
  for (let i = 0; i + 1 < turns.residuals.length; i += 2) pixels.add(Math.floor(turns.residuals[i] / FLOATS_PER_PIXEL));
  const sorted = [...pixels].sort((a, b) => a - b);
  const out = new Uint32Array(sorted.length * 2);
  sorted.forEach((p, i) => {
    out[i * 2] = p;
    out[i * 2 + 1] = 1;
  });
  return out;
}

/** The turns' pixel spans as a flat [pixelStart, pixelCount, ...] list. */
export function phaseTurnRanges(turns: PhaseTurns): Uint32Array {
  const out = new Uint32Array(turns.pixelStarts.length * 2);
  for (let i = 0; i < turns.pixelStarts.length; i++) {
    out[i * 2] = turns.pixelStarts[i];
    out[i * 2 + 1] = turns.pixelCounts[i];
  }
  return out;
}
