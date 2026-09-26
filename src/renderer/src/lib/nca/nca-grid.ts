import { levelOf, NCA_GRID, NCA_VISIBLE, quantisePhase } from "./nca-model";

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
 * silence. Both channels fold into one: their mean level, on the phase of
 * their sum.
 */
export function readGrid(spec: PackedSpectrogram, rect: UvRect, size = NCA_GRID): Float32Array {
  const grid = new Float32Array(size * size * NCA_VISIBLE);
  const texel = new Float32Array(4);
  for (let row = 0; row < size; row++) {
    const v = rect.y0 + ((row + 0.5) / size) * (rect.y1 - rect.y0);
    if (v < 0 || v >= 1) continue;
    for (let col = 0; col < size; col++) {
      const u = rect.x0 + ((col + 0.5) / size) * (rect.x1 - rect.x0);
      readPacked(spec, u, v, texel);
      const [magL, phaseL, magR, phaseR] = texel;
      const re = magL * Math.cos(phaseL) + magR * Math.cos(phaseR);
      const im = magL * Math.sin(phaseL) + magR * Math.sin(phaseR);
      const level = levelOf(0.5 * (magL + magR));
      const phase = Math.atan2(im, re);
      const i = (row * size + col) * NCA_VISIBLE;
      grid[i] = level;
      grid[i + 1] = level * Math.cos(phase);
      grid[i + 2] = level * Math.sin(phase);
    }
  }
  return grid;
}

/** The phase of each cell of a grid readGrid returned, quantised for NcaModel.phase. */
export function gridPhase(grid: Float32Array, size = NCA_GRID): Uint8Array {
  const phase = new Uint8Array(size * size);
  for (let cell = 0; cell < size * size; cell++) {
    phase[cell] = quantisePhase(Math.atan2(grid[cell * NCA_VISIBLE + 2], grid[cell * NCA_VISIBLE + 1]));
  }
  return phase;
}
