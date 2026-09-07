import { onsetReadSpan, type OnsetCurvesSlice, type PackedView } from "./onset-scan";
import { alignToBandGrid, packedViewOf } from "./packed-view";
import type { PackedLayout } from "./types";

/** What a synthesis pass gives back. */
export type SynthesisPass = {
  channels: Float32Array[];
  peak: number;
  gainReductionDb: Float32Array;
  maxGainReductionDb: number;
};

/** One synthesis pass that rebuilds [startFrame, endFrame) from a view of the packed state. */
export type SynthesiseView = (
  packed: Float32Array,
  meta: PackedLayout,
  existingAudio: Float32Array[],
  startFrame: number,
  endFrame: number,
) => Promise<SynthesisPass>;

/** Seconds of the file one pass rebuilds. */
export const SYNTHESIS_CHUNK_SECONDS = 30;

// What a pass reads outside the span it rebuilds: the synthesis support either
// side, and twice that again for the fill that feeds it. The support is capped
// at a tenth of a second, so this covers it several times over; the pass checks
// its own reach and refuses a view that falls short.
const REACH_SEC = 0.6;

/**
 * An onset pass run on each chunk's coefficients while the chunk is
 * synthesised, so the file is read once for both. The read is widened to the
 * whitening's warm-up, and the curves of every chunk come back together.
 */
export type ChunkOnsetPass = {
  curves: (packed: Float32Array, view: PackedView, startFrame: number, endFrame: number) => Promise<OnsetCurvesSlice>;
};

/**
 * The file's audio, rebuilt a chunk at a time so no pass holds more than its
 * own span of coefficients. `read` gathers the packed pixels of a range list.
 * Each pass splices its chunk into the audio the pass before it left, so the
 * seams are crossfades between two syntheses of the same coefficients.
 */
export async function synthesiseInChunks(
  synthesise: SynthesiseView,
  read: (ranges: Uint32Array) => Promise<Float32Array>,
  layout: PackedLayout,
  sampleRate: number,
  chunkSeconds = SYNTHESIS_CHUNK_SECONDS,
  onsets?: ChunkOnsetPass,
): Promise<SynthesisPass & { curves?: OnsetCurvesSlice[]; spans?: Array<[number, number]> }> {
  let channels: Float32Array[] = [];
  for (let ch = 0; ch < layout.numChannels; ch++) channels.push(new Float32Array(layout.numFrames));

  const chunkFrames = Math.max(1, Math.round(chunkSeconds * sampleRate));
  const curves: Promise<OnsetCurvesSlice>[] = [];
  const spans: Array<[number, number]> = [];
  let last: SynthesisPass | null = null;
  for (let start = 0; start < layout.numFrames; start += chunkFrames) {
    const end = Math.min(start + chunkFrames, layout.numFrames);
    if (onsets) {
      const wide = onsetReadSpan(layout, sampleRate, start, end, REACH_SEC, REACH_SEC);
      const meta: PackedLayout = { ...layout, viewStartFrame: wide.startFrame, viewEndFrame: wide.endFrame };
      const packed = await read(wide.ranges);
      const pass = synthesise(packed, meta, channels, start, end);
      curves.push(onsets.curves(packed, wide.view, start, end));
      spans.push([start, end]);
      last = await pass;
    } else {
      const span = alignToBandGrid(layout, start - REACH_SEC * sampleRate, end + REACH_SEC * sampleRate);
      const view = packedViewOf(layout, span.startFrame, span.endFrame);
      const meta: PackedLayout = { ...layout, viewStartFrame: span.startFrame, viewEndFrame: span.endFrame };
      last = await synthesise(await read(view.ranges), meta, channels, start, end);
    }
    channels = last.channels;
  }
  if (!last) throw new Error("the file has no frames to synthesise");
  if (!onsets) return { ...last, channels };
  return { ...last, channels, curves: await Promise.all(curves), spans };
}
