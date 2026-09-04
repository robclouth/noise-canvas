import { alignToBandGrid, packedViewOf } from "./packed-view";
import type { PackedLayout } from "./types";

/** What one onset pass reports, and what it learned about the file as a whole. */
export type OnsetDetection = { onsets: Float32Array; odfMax: number; bandMax: Float32Array };

/** One onset pass over a compact view of the packed state. */
export type DetectRegional = (
  packed: Float32Array,
  meta: PackedLayout,
  sampleRate: number,
  options: {
    startSec: number;
    endSec: number;
    odfReference: number;
    bandMax: Float32Array;
    gateOnly?: boolean;
    view: { offsets: Uint32Array; lens: Uint32Array; k0: Float64Array };
  },
) => Promise<OnsetDetection>;

/** The span of the file one pass reports on, when it is not the caller's own. */
export const ONSET_CHUNK_SECONDS = 45;

// What a pass reads outside the span it reports on: the whitening's warm-up and
// the mean taken before a peak, then the level and ridge windows measured after
// one. A margin over both, because a pass reading too little would report
// different events rather than refuse.
const LEAD_SEC = 6.0 + 0.08 + 0.5;
const TRAIL_SEC = 0.15 + 0.03 + 0.01 + 0.5;

function chunkSpans(numFrames: number, chunkFrames: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let start = 0; start < numFrames; start += chunkFrames) {
    spans.push([start, Math.min(start + chunkFrames, numFrames)]);
  }
  return spans.length > 0 ? spans : [[0, numFrames]];
}

/**
 * The onsets of one span of a file, reading only that span's coefficients
 * through `read`. `bandMax` is each band's loudest moment over the whole file
 * and `odfReference` the file's own gate: a pass seeing one span can find
 * neither, and would judge the span by what it holds alone.
 */
export async function scanOnsetChunk(
  detect: DetectRegional,
  read: (ranges: Uint32Array) => Promise<Float32Array>,
  layout: PackedLayout,
  sampleRate: number,
  bandMax: Float32Array,
  odfReference: number,
  startFrame: number,
  endFrame: number,
  gateOnly = false,
): Promise<OnsetDetection> {
  const span = alignToBandGrid(layout, startFrame - LEAD_SEC * sampleRate, endFrame + TRAIL_SEC * sampleRate);
  const view = packedViewOf(layout, span.startFrame, span.endFrame);
  const lens = new Uint32Array(layout.numBands);
  for (let b = 0; b < layout.numBands; b++) lens[b] = view.ranges[b * 2 + 1];
  return await detect(await read(view.ranges), layout, sampleRate, {
    startSec: startFrame / sampleRate,
    endSec: endFrame / sampleRate,
    odfReference,
    bandMax,
    gateOnly,
    view: { offsets: view.bandOffsets, lens, k0: Float64Array.from(view.bandK0) },
  });
}

/**
 * The file's onsets, found a chunk at a time so no pass holds more than its own
 * span of coefficients.
 *
 * Two rounds, because the silence gate is a share of the loudest moment of the
 * detection function anywhere in the file. The first round only reports that
 * moment; the second judges every chunk against it. A caller with no band
 * maxima to hand takes a round before both, since whitening reads them.
 */
export async function scanOnsets(
  detect: DetectRegional,
  read: (ranges: Uint32Array) => Promise<Float32Array>,
  layout: PackedLayout,
  sampleRate: number,
  bandMax: Float32Array,
  chunkSeconds = ONSET_CHUNK_SECONDS,
): Promise<OnsetDetection> {
  const spans = chunkSpans(layout.numFrames, Math.max(1, Math.round(chunkSeconds * sampleRate)));
  const chunk = (start: number, end: number, maxima: Float32Array, gate: number, gateOnly: boolean) =>
    scanOnsetChunk(detect, read, layout, sampleRate, maxima, gate, start, end, gateOnly);

  // A pass handed no maxima reports the ones its own span holds, so the file's
  // are the largest each band reaches over the chunks.
  let maxima = bandMax;
  if (maxima.length < layout.numBands) {
    maxima = new Float32Array(layout.numBands);
    const none = new Float32Array(0);
    for (const [startFrame, endFrame] of spans) {
      const found = (await chunk(startFrame, endFrame, none, 0, true)).bandMax;
      for (let b = 0; b < maxima.length; b++) maxima[b] = Math.max(maxima[b], found[b]);
    }
  }

  let gate = 0;
  for (const [startFrame, endFrame] of spans) {
    gate = Math.max(gate, (await chunk(startFrame, endFrame, maxima, 0, true)).odfMax);
  }

  const parts: Float32Array[] = [];
  let total = 0;
  for (const [startFrame, endFrame] of spans) {
    const part = (await chunk(startFrame, endFrame, maxima, gate, false)).onsets;
    parts.push(part);
    total += part.length;
  }
  const onsets = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    onsets.set(part, at);
    at += part.length;
  }
  return { onsets, odfMax: gate, bandMax: maxima };
}
