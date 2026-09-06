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

/**
 * How many passes a scan keeps in flight on a machine with `totalBytes` of
 * memory. Each pass holds its chunk's coefficients while the detector runs.
 */
export function onsetPassesInFlight(totalBytes: number): number {
  return Math.max(1, Math.min(3, Math.floor(totalBytes / (8 * 1024 ** 3))));
}

/** Runs `run` over the items in order, at most `limit` at a time; the results come back in item order. */
async function inFlight<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

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
 * maxima to hand takes a round before both, since whitening reads them. The
 * passes of one round are independent, so up to `passesInFlight` run at once.
 */
export async function scanOnsets(
  detect: DetectRegional,
  read: (ranges: Uint32Array) => Promise<Float32Array>,
  layout: PackedLayout,
  sampleRate: number,
  bandMax: Float32Array,
  chunkSeconds = ONSET_CHUNK_SECONDS,
  passesInFlight = 1,
): Promise<OnsetDetection> {
  const spans = chunkSpans(layout.numFrames, Math.max(1, Math.round(chunkSeconds * sampleRate)));
  const chunk = (start: number, end: number, maxima: Float32Array, gate: number, gateOnly: boolean) =>
    scanOnsetChunk(detect, read, layout, sampleRate, maxima, gate, start, end, gateOnly);

  // The reader keeps the blocks it served last, and the file was written from
  // its start, so each round walks the spans the other way from the one
  // before it and the first walks from the end.
  let forward = false;
  const round = (): Array<[number, number]> => {
    const order = forward ? spans : [...spans].reverse();
    forward = !forward;
    return order;
  };

  // A pass handed no maxima reports the ones its own span holds, so the file's
  // are the largest each band reaches over the chunks.
  let maxima = bandMax;
  if (maxima.length < layout.numBands) {
    maxima = new Float32Array(layout.numBands);
    const none = new Float32Array(0);
    const found = await inFlight(round(), passesInFlight, ([start, end]) => chunk(start, end, none, 0, true));
    for (const pass of found) {
      for (let b = 0; b < maxima.length; b++) maxima[b] = Math.max(maxima[b], pass.bandMax[b]);
    }
  }

  let gate = 0;
  const gates = await inFlight(round(), passesInFlight, ([start, end]) => chunk(start, end, maxima, 0, true));
  for (const pass of gates) gate = Math.max(gate, pass.odfMax);

  const order = round();
  const passes = await inFlight(order, passesInFlight, ([start, end]) => chunk(start, end, maxima, gate, false));
  const parts = new Map<number, Float32Array>();
  let total = 0;
  for (let i = 0; i < order.length; i++) {
    parts.set(order[i][0], passes[i].onsets);
    total += passes[i].onsets.length;
  }
  const onsets = new Float32Array(total);
  let at = 0;
  for (const [startFrame] of spans) {
    const part = parts.get(startFrame)!;
    onsets.set(part, at);
    at += part.length;
  }
  return { onsets, odfMax: gate, bandMax: maxima };
}
