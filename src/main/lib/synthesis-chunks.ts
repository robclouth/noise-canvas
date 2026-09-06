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
): Promise<SynthesisPass> {
  let channels: Float32Array[] = [];
  for (let ch = 0; ch < layout.numChannels; ch++) channels.push(new Float32Array(layout.numFrames));

  const chunkFrames = Math.max(1, Math.round(chunkSeconds * sampleRate));
  let last: SynthesisPass | null = null;
  for (let start = 0; start < layout.numFrames; start += chunkFrames) {
    const end = Math.min(start + chunkFrames, layout.numFrames);
    const span = alignToBandGrid(layout, start - REACH_SEC * sampleRate, end + REACH_SEC * sampleRate);
    const view = packedViewOf(layout, span.startFrame, span.endFrame);
    const meta: PackedLayout = { ...layout, viewStartFrame: span.startFrame, viewEndFrame: span.endFrame };
    last = await synthesise(await read(view.ranges), meta, channels, start, end);
    channels = last.channels;
  }
  if (!last) throw new Error("the file has no frames to synthesise");
  return { ...last, channels };
}
