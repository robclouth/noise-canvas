import type { SpectrogramData } from "../store/types";
import { packedTextureSizeOf } from "./canvas-view";
import type { PackedSpan } from "./packed-span";
import { selectionBandRange, selectionFrameRange, selectionMaskTest, type Selection } from "./selection";
import { sourceBandUvSlope } from "./utils";

/**
 * A copied region, held as a file in its own right: the same bands as the file
 * it came from, cropped in time to what was copied and silent outside it.
 *
 * Keeping every band means the clipboard's frequencies are the source file's
 * frequencies, so a paste back into that file needs no mapping at all. Only the
 * time axis shrinks, which is what makes the copy small.
 */
export interface ClipboardRegion {
  spec: SpectrogramData;
  /** The rectangle it was copied from, in the source file's own seconds. */
  rect: Selection;
  /** The frame the crop starts at, which is where the clipboard's own time zero sits. */
  originFrame: number;
  sourceName: string;
  /**
   * The source's detected onsets inside the copied span, as [timeSec, salience]
   * pairs in the clipboard's own time. The Sharp warp re-anchors phase at them,
   * so a paste moves transients the way a translation does.
   */
  onsets: Float32Array;
  /** The source file's onset sensitivity, so the paste filters onsets as it would. */
  onsetSensitivity: number;
}

/** The widest bin step among the bands a selection covers, in frames. */
function coarsestCell(selection: Selection, spec: SpectrogramData): number {
  const { lowBand, highBand } = selectionBandRange(selection, spec.numBands);
  let coarsest = 1;
  for (let band = lowBand; band <= highBand; band++) {
    coarsest = Math.max(coarsest, 2 ** spec.metadata[band * 4 + 2]);
  }
  return coarsest;
}

/**
 * Copies `selection` out of `span`, which must cover its frames, into a file of its own.
 *
 * The crop starts on a whole number of the coarsest bin step among the copied
 * bands, so every band's bin 0 lands on a bin of the source. Bins the selection
 * does not cover are left silent rather than dropped, which keeps the band
 * layout — and so the frequencies — identical to the source file's.
 */
export function buildClipboardRegion(
  span: PackedSpan,
  selection: Selection,
  spec: SpectrogramData,
  sourceName: string,
  sourceOnsets?: Float32Array,
  onsetSensitivity = 50,
): ClipboardRegion | null {
  const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
  const { lowBand, highBand } = selectionBandRange(selection, spec.numBands);
  if (endFrame <= startFrame || highBand < lowBand) return null;
  const maskTest = selectionMaskTest(selection, spec.sampleRate, spec.numBands);

  const cell = coarsestCell(selection, spec);
  const originFrame = Math.max(0, Math.floor(startFrame / cell) * cell);
  const clipFrames = Math.min(spec.numFrames - originFrame, Math.ceil((endFrame - originFrame) / cell) * cell);
  if (clipFrames <= 0) return null;

  const { numBands, numChannels, sampleRate, minFreq, bandsPerOctave } = spec;
  const bandOffsets = new Uint32Array(numBands);
  const bandLengths = new Uint32Array(numBands);
  const bandStepLog2s = new Int32Array(numBands);

  let total = 0;
  for (let band = 0; band < numBands; band++) {
    const stepLog2 = spec.synthesisMetadata.bandStepLog2s[band];
    const length = ((clipFrames - 1) >> stepLog2) + 1;
    bandStepLog2s[band] = stepLog2;
    bandLengths[band] = length;
    bandOffsets[band] = total;
    total += length;
  }

  const packedTextureSize = packedTextureSizeOf(total);
  const textureWidth = packedTextureSize.x;
  const textureHeight = packedTextureSize.y;
  if (textureWidth <= 0 || textureHeight <= 0) return null;

  const packedData = new Float32Array(textureWidth * textureHeight * 4);
  const inverseMap = new Float32Array(textureWidth * textureHeight * 2);
  for (let i = 0; i < textureWidth * textureHeight; i++) {
    inverseMap[i * 2 + 1] = numBands - 1;
  }

  for (let band = 0; band < numBands; band++) {
    const step = 1 << bandStepLog2s[band];
    const length = bandLengths[band];
    const sourceLength = spec.synthesisMetadata.bandLengths[band];
    const copied = band >= lowBand && band <= highBand;
    // Bins are claimed by their left edge, the rule the shader's selection clip
    // and the brush's own time coverage both use.
    const firstBin = Math.ceil(startFrame / step);
    const lastBin = Math.ceil(endFrame / step);

    for (let k = 0; k < length; k++) {
      const target = bandOffsets[band] + k;
      inverseMap[target * 2] = k * step;
      inverseMap[target * 2 + 1] = band;
      if (!copied) continue;
      const sourceBin = (originFrame >> bandStepLog2s[band]) + k;
      if (sourceBin < firstBin || sourceBin >= lastBin || sourceBin >= sourceLength) continue;
      if (maskTest && !maskTest(band, sourceBin * step)) continue;
      const pixel = span.pixel(band, sourceBin);
      if (pixel < 0) continue;
      packedData.set(span.values.subarray(pixel * 4, pixel * 4 + 4), target * 4);
    }
  }

  const metadata = new Float64Array(numBands * 4);
  for (let band = 0; band < numBands; band++) {
    metadata[band * 4] = bandOffsets[band];
    metadata[band * 4 + 1] = bandLengths[band];
    metadata[band * 4 + 2] = bandStepLog2s[band];
    // The frequencies are the source file's, unchanged.
    metadata[band * 4 + 3] = spec.metadata[band * 4 + 3];
  }

  const clipOnsets: number[] = [];
  if (sourceOnsets) {
    const originSec = originFrame / sampleRate;
    for (let i = 0; i + 1 < sourceOnsets.length; i += 2) {
      const time = sourceOnsets[i];
      if (time < selection.start || time >= selection.end) continue;
      clipOnsets.push(time - originSec, sourceOnsets[i + 1]);
    }
  }

  return {
    spec: {
      packedData,
      inverseMap,
      metadata,
      texels: total,
      numFrames: clipFrames,
      numBands,
      numChannels,
      sampleRate,
      packedTextureSize,
      minFreq,
      bandsPerOctave,
      magnitudeEnergy: spec.magnitudeEnergy,
      synthesisMetadata: { bandOffsets, bandStepLog2s, bandLengths },
    },
    rect: selection,
    originFrame,
    sourceName,
    onsets: new Float32Array(clipOnsets),
    onsetSensitivity,
  };
}

/**
 * Where a drop lands, as the rectangle the pasted sound will occupy. The
 * clipboard keeps its own size, so only the corner moves. The height converts
 * into `dest`'s band UV, so the sound spans the same octaves whatever layout
 * it lands in; in its own file the conversion is exactly 1.
 */
export function dropRect(
  clipboard: ClipboardRegion,
  aimTimeSeconds: number,
  aimPitchUv: number,
  dest: { numBands: number; bandsPerOctave: number },
): Selection {
  const { rect, spec } = clipboard;
  const span = (rect.pitchHi - rect.pitchLo) * sourceBandUvSlope(spec, dest);
  return {
    start: aimTimeSeconds,
    end: aimTimeSeconds + (rect.end - rect.start),
    pitchLo: aimPitchUv,
    pitchHi: aimPitchUv + span,
    // The mask reads proportionally within its rectangle, so it moves — and
    // crosses layouts — with the corner untouched.
    ...(rect.mask ? { mask: rect.mask } : {}),
  };
}

/**
 * How far into the clipboard's own file its copied corner sits, as a fraction
 * of each axis. A paste anchors the source there, so the copied sound lands
 * under the brush's corner rather than the crop's.
 */
export function clipboardSourceOffset(clipboard: ClipboardRegion): { timeFraction: number; pitchFraction: number } {
  const { spec, rect, originFrame } = clipboard;
  const startFrame = Math.floor(rect.start * spec.sampleRate + 0.5);
  return {
    timeFraction: spec.numFrames > 0 ? (startFrame - originFrame) / spec.numFrames : 0,
    pitchFraction: rect.pitchLo,
  };
}
