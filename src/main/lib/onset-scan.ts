import { alignToBandGrid, packedViewOf } from "./packed-view";
import type { PackedLayout } from "./types";

/** What one onset pass reports, and what it learned about the file as a whole. */
export type OnsetDetection = { onsets: Float32Array; odfMax: number; bandMax: Float32Array };

/** The coefficients of a span of the file, as a view: per-band offsets, lengths and first coefficient index. */
export type PackedView = { offsets: Uint32Array; lens: Uint32Array; k0: Float64Array };

/**
 * The detection curves of one span of the file, at `ONSET_BIN_SEC` per bin
 * from `binStart`, and the loudest moment of the detection function in them.
 */
export type OnsetCurvesSlice = {
  odf: Float64Array;
  energy: Float64Array;
  binStart: number;
  odfMax: number;
  bandMax: Float32Array;
};

/** Seconds per bin of the detection curves. */
export const ONSET_BIN_SEC = 0.0005;

/** The passes an onset scan is made of. */
export type OnsetPasses = {
  /** Events of one span, judged against a gate the caller hands over. */
  detect: DetectRegional;
  /** The detection curves of one span, from the coefficients of a view around it. */
  curves: (
    packed: Float32Array,
    meta: PackedLayout,
    sampleRate: number,
    options: { startSec: number; endSec: number; bandMax: Float32Array; view: PackedView },
  ) => Promise<OnsetCurvesSlice>;
  /** Where the events are, off curves covering the whole file, in seconds. */
  pick: (
    odf: Float64Array,
    energy: Float64Array,
    numFrames: number,
    sampleRate: number,
    odfGate: number,
  ) => Promise<Float64Array>;
  /** How big the events in [startSec, endSec) are, read off a view of the coefficients around them. */
  salience: (
    packed: Float32Array,
    meta: PackedLayout,
    sampleRate: number,
    options: { times: Float64Array; startSec: number; endSec: number; view: PackedView },
  ) => Promise<Float32Array>;
};

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
export const ONSET_LEAD_SEC = 6.0 + 0.08 + 0.5;
export const ONSET_TRAIL_SEC = 0.15 + 0.03 + 0.01 + 0.5;
const LEAD_SEC = ONSET_LEAD_SEC;
const TRAIL_SEC = ONSET_TRAIL_SEC;

// What measuring an event reads: a few coefficients of the slowest band before
// it, and the moment its level is looked for after it.
const SALIENCE_LEAD_SEC = 0.5;
const SALIENCE_TRAIL_SEC = 0.15 + 0.5;

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

/** The view a pass reads for the span [startFrame, endFrame), widened by `leadSec` and `trailSec`. */
function viewAround(
  layout: PackedLayout,
  sampleRate: number,
  startFrame: number,
  endFrame: number,
  leadSec: number,
  trailSec: number,
): { ranges: Uint32Array; view: PackedView } {
  const span = alignToBandGrid(layout, startFrame - leadSec * sampleRate, endFrame + trailSec * sampleRate);
  const view = packedViewOf(layout, span.startFrame, span.endFrame);
  const lens = new Uint32Array(layout.numBands);
  for (let b = 0; b < layout.numBands; b++) lens[b] = view.ranges[b * 2 + 1];
  return { ranges: view.ranges, view: { offsets: view.bandOffsets, lens, k0: Float64Array.from(view.bandK0) } };
}

/**
 * The detection curves of [startFrame, endFrame), from the coefficients of a
 * view reaching the whitening's warm-up before it. `packed` may be handed over
 * by a caller that read that view itself; otherwise it is read here.
 */
export async function onsetCurvesOfSpan(
  passes: Pick<OnsetPasses, "curves">,
  read: (ranges: Uint32Array) => Promise<Float32Array>,
  layout: PackedLayout,
  sampleRate: number,
  bandMax: Float32Array,
  startFrame: number,
  endFrame: number,
  packed?: { values: Float32Array; view: PackedView },
): Promise<OnsetCurvesSlice> {
  const around = packed ? null : viewAround(layout, sampleRate, startFrame, endFrame, LEAD_SEC, TRAIL_SEC);
  const values = packed ? packed.values : await read(around!.ranges);
  const view = packed ? packed.view : around!.view;
  return await passes.curves(values, layout, sampleRate, {
    startSec: startFrame / sampleRate,
    endSec: endFrame / sampleRate,
    bandMax,
    view,
  });
}

/** The view a fused pass reads so it serves both the synthesis and the onset curves of [startFrame, endFrame). */
export function onsetReadSpan(
  layout: PackedLayout,
  sampleRate: number,
  startFrame: number,
  endFrame: number,
  leadSec: number,
  trailSec: number,
): { ranges: Uint32Array; view: PackedView; startFrame: number; endFrame: number } {
  const span = alignToBandGrid(
    layout,
    startFrame - Math.max(leadSec, LEAD_SEC) * sampleRate,
    endFrame + Math.max(trailSec, TRAIL_SEC) * sampleRate,
  );
  const around = viewAround(layout, sampleRate, span.startFrame, span.endFrame, 0, 0);
  return { ...around, startFrame: span.startFrame, endFrame: span.endFrame };
}

/**
 * The file's onsets from the curves of every span of it: the gate is the
 * loudest moment of the detection function over the whole, the events are
 * picked off the curves laid end to end, and each event's size is then read
 * off the coefficients around it, a span at a time.
 */
export async function finishOnsets(
  passes: Pick<OnsetPasses, "pick" | "salience">,
  read: (ranges: Uint32Array) => Promise<Float32Array>,
  layout: PackedLayout,
  sampleRate: number,
  slices: OnsetCurvesSlice[],
  bandMax: Float32Array,
  passesInFlight = 1,
  spans?: Array<[number, number]>,
): Promise<OnsetDetection> {
  const durationSec = layout.numFrames / sampleRate;
  const numBins = Math.max(1, Math.ceil(durationSec / ONSET_BIN_SEC));
  const odf = new Float64Array(numBins);
  const energy = new Float64Array(numBins);
  const ordered = [...slices].sort((a, b) => a.binStart - b.binStart);
  let at = 0;
  let gate = 0;
  for (const slice of ordered) {
    if (slice.binStart !== at || slice.odf.length !== slice.energy.length) {
      throw new Error("the onset curves do not cover the file");
    }
    odf.set(slice.odf, at);
    energy.set(slice.energy, at);
    at += slice.odf.length;
    gate = Math.max(gate, slice.odfMax);
  }
  if (at !== numBins) throw new Error("the onset curves do not cover the file");

  const times = await passes.pick(odf, energy, layout.numFrames, sampleRate, gate);
  const order = spans ?? chunkSpans(layout.numFrames, Math.max(1, Math.round(ONSET_CHUNK_SECONDS * sampleRate)));
  const parts = new Map<number, Float32Array>();
  await inFlight(order, passesInFlight, async ([start, end]) => {
    const startSec = start / sampleRate;
    const endSec = end / sampleRate;
    let inside = 0;
    for (const t of times) if (t >= startSec && t < endSec) inside++;
    if (inside === 0) {
      parts.set(start, new Float32Array(0));
      return;
    }
    const around = viewAround(layout, sampleRate, start, end, SALIENCE_LEAD_SEC, SALIENCE_TRAIL_SEC);
    const measured = await passes.salience(await read(around.ranges), layout, sampleRate, {
      times,
      startSec,
      endSec,
      view: around.view,
    });
    parts.set(start, measured);
  });
  let total = 0;
  for (const part of parts.values()) total += part.length;
  const onsets = new Float32Array(total);
  let cursor = 0;
  for (const [start] of [...order].sort((a, b) => a[0] - b[0])) {
    const part = parts.get(start) ?? new Float32Array(0);
    onsets.set(part, cursor);
    cursor += part.length;
  }
  return { onsets, odfMax: gate, bandMax };
}

/**
 * The file's onsets, found a chunk at a time so no pass holds more than its own
 * span of coefficients.
 *
 * One round reads every chunk for its detection curves; the events are then
 * picked off the curves of the whole file at once, and a last round reads
 * around them to measure each. A caller with no band maxima to hand takes a
 * round before both, since whitening reads them. The passes of one round are
 * independent, so up to `passesInFlight` run at once.
 */
export async function scanOnsets(
  passes: OnsetPasses,
  read: (ranges: Uint32Array) => Promise<Float32Array>,
  layout: PackedLayout,
  sampleRate: number,
  bandMax: Float32Array,
  chunkSeconds = ONSET_CHUNK_SECONDS,
  passesInFlight = 1,
): Promise<OnsetDetection> {
  const spans = chunkSpans(layout.numFrames, Math.max(1, Math.round(chunkSeconds * sampleRate)));

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
    const found = await inFlight(round(), passesInFlight, ([start, end]) =>
      scanOnsetChunk(passes.detect, read, layout, sampleRate, none, 0, start, end, true),
    );
    for (const pass of found) {
      for (let b = 0; b < maxima.length; b++) maxima[b] = Math.max(maxima[b], pass.bandMax[b]);
    }
  }

  const slices = await inFlight(round(), passesInFlight, ([start, end]) =>
    onsetCurvesOfSpan(passes, read, layout, sampleRate, maxima, start, end),
  );
  return await finishOnsets(passes, read, layout, sampleRate, slices, maxima, passesInFlight, round());
}
