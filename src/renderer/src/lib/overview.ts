import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  NearestFilter,
  RGBAFormat,
  RGFormat,
} from "three";
import type { PixelFormatGPU } from "three";
import type { PackedLayout } from "./window-layout";
import { bandOfFilePixel } from "./window-layout";

// The analyser's packed texture dimension limit, applied to the overview too.
const MAX_TEXTURE_SIZE = 8192;

/**
 * Frames one overview bin covers, as a power of two. Bands whose own bins are
 * already this coarse keep them, so the overview holds the file itself there
 * and the display reads the same level from either. Every other band collapses
 * to this step, which puts the whole overview on one time resolution: the zoom
 * at which the display prefers it is then the same in every band, and no band
 * boundary shows a join.
 */
export const OVERVIEW_STEP_LOG2 = 11;

/** Bins of `file` band `band` that one overview bin collapses. */
export function overviewDecimationOf(file: PackedLayout, band: number, stepLog2 = OVERVIEW_STEP_LOG2): number {
  return 2 ** Math.max(0, stepLog2 - file.bandStepLog2s[band]);
}

/**
 * The overview holds dB, not linear magnitude. Half float's smallest normal is
 * 6.1e-5 — about −77.5 dBFS against a Min dB control that reaches −120 — and
 * its largest is 65504 against a magnitude ceiling of 1e15, so a linear store
 * would floor quiet content to black and overflow loud content to white. dB has
 * no subnormal region here and cannot overflow, and because `max` commutes with
 * a monotone map the decimation is unchanged by storing it.
 *
 * The full-scale offset is NOT folded in: the display adds it, and it is a
 * calibration the overview should not have to be rebuilt for.
 */
export function magnitudeToDb(magnitude: number): number {
  return 20 * Math.log10(magnitude + 1e-7);
}

/** A decimated whole-file view, on the file's dyadic layout at one time step. */
export interface Overview {
  layout: PackedLayout;
  /** RG16F: (dB left, dB right) per overview bin. */
  data: Uint16Array;
  /** The `numBands × 1` metadata the overview is addressed by. */
  metadata: Float32Array;
  stepLog2: number;
}

/** The packed layout of an overview over `file`. */
export function buildOverviewLayout(file: PackedLayout, stepLog2 = OVERVIEW_STEP_LOG2): PackedLayout {
  if (!Number.isInteger(stepLog2)) throw new Error("The overview step exponent must be a whole number.");

  const bandOffsets = new Uint32Array(file.numBands);
  const bandLengths = new Uint32Array(file.numBands);
  const bandStepLog2s = new Int32Array(file.numBands);

  let total = 0;
  for (let b = 0; b < file.numBands; b++) {
    const decimation = overviewDecimationOf(file, b, stepLog2);
    bandStepLog2s[b] = file.bandStepLog2s[b] + Math.log2(decimation);
    bandLengths[b] = Math.max(1, Math.ceil(file.bandLengths[b] / decimation));
    bandOffsets[b] = total;
    total += bandLengths[b];
  }

  const textureWidth = Math.min(MAX_TEXTURE_SIZE, total);
  const textureHeight = total > 0 ? Math.ceil(total / textureWidth) : 0;

  return {
    numFrames: file.numFrames,
    numBands: file.numBands,
    bandOffsets,
    bandLengths,
    bandStepLog2s,
    textureWidth,
    textureHeight,
  };
}

/** The overview's metadata texture, one row, in the layout the shaders already read. */
export function buildOverviewMetadata(overview: PackedLayout, fileMetadata: Float32Array): Float32Array {
  const out = new Float32Array(overview.numBands * 4);
  for (let b = 0; b < overview.numBands; b++) {
    out[b * 4 + 0] = overview.bandOffsets[b];
    out[b * 4 + 1] = overview.bandLengths[b];
    out[b * 4 + 2] = overview.bandStepLog2s[b];
    out[b * 4 + 3] = fileMetadata[b * 4 + 3];
  }
  return out;
}

/** Decimates one overview bin out of the file's packed magnitudes. */
function reduceBin(
  packedData: Float32Array,
  fileBandStart: number,
  firstFileBin: number,
  binCount: number,
): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (let i = 0; i < binCount; i++) {
    const pixel = (fileBandStart + firstFileBin + i) * 4;
    if (packedData[pixel] > left) left = packedData[pixel];
    if (packedData[pixel + 2] > right) right = packedData[pixel + 2];
  }
  return { left, right };
}

function writeBin(data: Uint16Array, overviewPixel: number, left: number, right: number): void {
  data[overviewPixel * 2 + 0] = DataUtils.toHalfFloat(magnitudeToDb(left));
  data[overviewPixel * 2 + 1] = DataUtils.toHalfFloat(magnitudeToDb(right));
}

/**
 * Builds the whole-file overview. Each overview bin is the **max** over its
 * group of file bins, per channel — max, not mean, so a transient survives
 * zoom-out instead of averaging away.
 */
export function buildOverview(
  packedData: Float32Array,
  file: PackedLayout,
  fileMetadata: Float32Array,
  stepLog2 = OVERVIEW_STEP_LOG2,
): Overview {
  const layout = buildOverviewLayout(file, stepLog2);
  const data = new Uint16Array(layout.textureWidth * layout.textureHeight * 2);

  for (let b = 0; b < file.numBands; b++) {
    const fileBandStart = file.bandOffsets[b];
    const fileLength = file.bandLengths[b];
    const decimation = overviewDecimationOf(file, b, stepLog2);
    for (let k = 0; k < layout.bandLengths[b]; k++) {
      const first = k * decimation;
      const count = Math.min(decimation, fileLength - first);
      if (count <= 0) continue;
      const { left, right } = reduceBin(packedData, fileBandStart, first, count);
      writeBin(data, layout.bandOffsets[b] + k, left, right);
    }
  }

  return { layout, data, metadata: buildOverviewMetadata(layout, fileMetadata), stepLog2 };
}

/**
 * Re-decimates the overview bins that `ranges` touches.
 *
 * A max cannot be updated incrementally when a value falls, so every file bin
 * of a touched group is re-read even if the patch covered only one of them.
 */
export function updateOverviewRanges(
  overview: Overview,
  packedData: Float32Array,
  file: PackedLayout,
  ranges: Uint32Array,
): void {
  const { layout, data } = overview;

  for (let i = 0; i < ranges.length; i += 2) {
    let start = ranges[i];
    const end = start + ranges[i + 1];
    while (start < end) {
      const band = bandOfFilePixel(file, start);
      if (band < 0) break;
      const fileBandStart = file.bandOffsets[band];
      const fileLength = file.bandLengths[band];
      const decimation = overviewDecimationOf(file, band, overview.stepLog2);
      const chunkEnd = Math.min(end, fileBandStart + fileLength);

      const firstGroup = Math.floor((start - fileBandStart) / decimation);
      const lastGroup = Math.floor((chunkEnd - 1 - fileBandStart) / decimation);
      for (let k = firstGroup; k <= lastGroup && k < layout.bandLengths[band]; k++) {
        const first = k * decimation;
        const count = Math.min(decimation, fileLength - first);
        if (count <= 0) continue;
        const { left, right } = reduceBin(packedData, fileBandStart, first, count);
        writeBin(data, layout.bandOffsets[band] + k, left, right);
      }

      start = chunkEnd;
    }
  }
}

function configure(texture: DataTexture, internalFormat: PixelFormatGPU): DataTexture {
  texture.internalFormat = internalFormat;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** The overview's GPU textures: RG16F dB, and the one-row band metadata. */
export function createOverviewTextures(overview: Overview): { data: DataTexture; meta: DataTexture } {
  const { layout } = overview;
  return {
    data: configure(
      new DataTexture(overview.data, layout.textureWidth, layout.textureHeight, RGFormat, HalfFloatType),
      "RG16F",
    ),
    meta: configure(new DataTexture(overview.metadata, layout.numBands, 1, RGBAFormat, FloatType), "RGBA32F"),
  };
}
