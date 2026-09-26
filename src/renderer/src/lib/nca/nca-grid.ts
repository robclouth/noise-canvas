import {
  levelOf,
  NCA_GRID,
  NCA_PATH_SCALE,
  NCA_RATE_SCALE,
  NCA_ROUGHNESS_FULL,
  NCA_VISIBLE,
  quantisePhase,
} from "./nca-model";

/** What the grid reader needs from a spectrogram: its packed data and layout. */
export type PackedSpectrogram = {
  packedData: Float32Array;
  /** Per band: start offset, length, log2 time step, centre frequency. */
  metadata: Float32Array;
  numFrames: number;
  numBands: number;
};

/** A rectangle in unpacked UV: x along time, y up in pitch, both 0–1 over the file. */
export type UvRect = { x0: number; y0: number; x1: number; y1: number };

/**
 * Point-samples one coefficient pair at an unpacked UV, as readPackedData does
 * in the shaders: band from the height, frame from the band's own time step.
 */
function readPacked(spec: PackedSpectrogram, u: number, v: number, out: Float32Array): void {
  const wrappedU = u - Math.floor(u);
  const band = Math.min(spec.numBands - 1, Math.max(0, Math.floor((1 - v) * spec.numBands)));
  const start = spec.metadata[band * 4];
  const length = spec.metadata[band * 4 + 1];
  const stepLog2 = spec.metadata[band * 4 + 2];
  const frame = Math.min(length - 1, Math.max(0, Math.floor((wrappedU * spec.numFrames) / Math.pow(2, stepLog2))));
  const index = (start + frame) * 4;
  for (let k = 0; k < 4; k++) out[k] = spec.packedData[index + k] ?? 0;
}

/**
 * The audible channels of an NCA grid over `rect`: row-major, row 0 lowest in
 * pitch, NCA_VISIBLE values per cell. Outside the file's pitch range reads as
 * silence. The level is the mean of the two channels. The phase is the left
 * channel's, which the packed format stores unwrapped along time within each
 * band, so it reads as a path: how far the phase has moved since the row's
 * first cell, and how far it moved over the last cell.
 */
export function readGrid(spec: PackedSpectrogram, rect: UvRect, size = NCA_GRID): Float32Array {
  const grid = new Float32Array(size * size * NCA_VISIBLE);
  const texel = new Float32Array(4);
  for (let row = 0; row < size; row++) {
    const v = rect.y0 + ((row + 0.5) / size) * (rect.y1 - rect.y0);
    if (v < 0 || v >= 1) continue;
    let first = 0;
    let previous = 0;
    for (let col = 0; col < size; col++) {
      const u = rect.x0 + ((col + 0.5) / size) * (rect.x1 - rect.x0);
      readPacked(spec, u, v, texel);
      const phase = texel[1];
      if (col === 0) first = previous = phase;
      const i = (row * size + col) * NCA_VISIBLE;
      grid[i] = levelOf(0.5 * (texel[0] + texel[2]));
      grid[i + 1] = (phase - first) / NCA_PATH_SCALE;
      grid[i + 2] = (phase - previous) / NCA_RATE_SCALE;
      previous = phase;
    }
  }
  return grid;
}

/**
 * Where each row's phase path starts: the left channel's phase at the row's
 * first cell, quantised for NcaModel.phase.
 */
export function readAnchors(spec: PackedSpectrogram, rect: UvRect, size = NCA_GRID): Uint8Array {
  const anchors = new Uint8Array(size);
  const texel = new Float32Array(4);
  for (let row = 0; row < size; row++) {
    const v = rect.y0 + ((row + 0.5) / size) * (rect.y1 - rect.y0);
    if (v < 0 || v >= 1) continue;
    readPacked(spec, rect.x0 + (0.5 / size) * (rect.x1 - rect.x0), v, texel);
    anchors[row] = quantisePhase(texel[1]);
  }
  return anchors;
}

/**
 * How rough each row's phase is in a grid readGrid returned: the mean change
 * in phase rate from cell to cell, as a byte from smooth (0) to random (255).
 */
export function gridRoughness(grid: Float32Array, size = NCA_GRID): Uint8Array {
  const roughness = new Uint8Array(size);
  for (let row = 0; row < size; row++) {
    let sum = 0;
    for (let col = 1; col < size; col++) {
      const rate = grid[(row * size + col) * NCA_VISIBLE + 2];
      const previous = grid[(row * size + col - 1) * NCA_VISIBLE + 2];
      sum += Math.abs(rate - previous) * NCA_RATE_SCALE;
    }
    roughness[row] = Math.round(Math.min(1, sum / (size - 1) / NCA_ROUGHNESS_FULL) * 255);
  }
  return roughness;
}
