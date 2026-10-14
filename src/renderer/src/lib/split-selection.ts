import type { SpectrogramData } from "../store/types";
import { PackedSpan, readPackedSpan } from "./packed-span";
import { gatherPixelRanges } from "./pixel-ranges";
import { selectionBandRange, selectionFrameRange, selectionMaskTest, type Selection } from "./selection";

/** Seconds read either side of a selection, so a separator's filters see past its edges. */
export const SPLIT_MARGIN_SECONDS = 3;

type SplitSpec = Pick<SpectrogramData, "numBands" | "metadata" | "numFrames" | "sampleRate" | "synthesisMetadata">;

/** The selection and a margin either side, in frames, clamped to the file. */
export function splitFrameSpan(spec: Pick<SpectrogramData, "numFrames" | "sampleRate">, selection: Selection) {
  const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
  const margin = Math.round(SPLIT_MARGIN_SECONDS * spec.sampleRate);
  return { startFrame: Math.max(0, startFrame - margin), endFrame: Math.min(spec.numFrames, endFrame + margin) };
}

/** The blocks around `selection` and its margin, cut from `whole`, the file's whole packed run. */
export async function selectionSpan(spec: SplitSpec, whole: Float32Array, selection: Selection): Promise<PackedSpan> {
  const { startFrame, endFrame } = splitFrameSpan(spec, selection);
  const span = await readPackedSpan(spec, startFrame, endFrame, (ranges) =>
    Promise.resolve(gatherPixelRanges(whole, ranges)),
  );
  if (!span) throw new Error("Could not read the selection.");
  return span;
}

/** A span's band tables, in the shape the separators take. */
export function spanBandTables(span: PackedSpan, numChannels: number) {
  const { numBands, metadata } = span.view.layout;
  const bandOffsets = new Uint32Array(numBands);
  const bandLengths = new Uint32Array(numBands);
  for (let band = 0; band < numBands; band++) {
    bandOffsets[band] = metadata[band * 4];
    bandLengths[band] = metadata[band * 4 + 1];
  }
  return { numBands, numChannels, bandOffsets, bandLengths };
}

/**
 * Whole-file parts of a split that acts on `selection` alone. Part 0 is
 * `whole` with `parts[0]` inside the selection; every other part is silence
 * with its own part inside. Bins are inside by their left edge, the rule Copy
 * uses. `whole` itself is not changed.
 */
export function spliceSelectionParts(
  spec: SplitSpec,
  whole: Float32Array,
  parts: PackedSpan[],
  selection: Selection,
): Float32Array[] {
  const out = parts.map((_, i) => (i === 0 ? whole.slice() : new Float32Array(whole.length)));
  const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
  const { lowBand, highBand } = selectionBandRange(selection, spec.numBands);
  const maskTest = selectionMaskTest(selection, spec.sampleRate, spec.numBands);
  const { bandOffsets, bandLengths, bandStepLog2s } = spec.synthesisMetadata;
  for (let band = lowBand; band <= highBand; band++) {
    const step = 2 ** bandStepLog2s[band];
    const firstBin = Math.ceil(startFrame / step);
    const lastBin = Math.min(Math.ceil(endFrame / step), bandLengths[band]);
    for (let bin = firstBin; bin < lastBin; bin++) {
      if (maskTest && !maskTest(band, bin * step)) continue;
      const target = (bandOffsets[band] + bin) * 4;
      parts.forEach((part, i) => {
        const pixel = part.pixel(band, bin);
        if (pixel < 0) throw new Error("The separated span does not cover the selection.");
        out[i].set(part.values.subarray(pixel * 4, pixel * 4 + 4), target);
      });
    }
  }
  return out;
}

/** `span` placed at frame `from` of silent channels `length` frames long. */
export function placeAudioSpan(span: Float32Array[], from: number, length: number): Float32Array[] {
  return span.map((channel) => {
    const out = new Float32Array(length);
    out.set(channel.subarray(0, Math.max(0, Math.min(channel.length, length - from))), from);
    return out;
  });
}
