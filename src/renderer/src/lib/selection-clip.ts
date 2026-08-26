import { Vector2 } from "three";
import type { SpectrogramData } from "../store/types";
import { selectionBandRange, selectionFrameRange, type Selection } from "./selection";

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
 * Copies `selection` out of `data` into a file of its own.
 *
 * The crop starts on a whole number of the coarsest bin step among the copied
 * bands, so every band's bin 0 lands on a bin of the source. Bins the selection
 * does not cover are left silent rather than dropped, which keeps the band
 * layout — and so the frequencies — identical to the source file's.
 */
export function buildClipboardRegion(
  data: Float32Array,
  selection: Selection,
  spec: SpectrogramData,
  sourceName: string,
): ClipboardRegion | null {
  const { startFrame, endFrame } = selectionFrameRange(selection, spec.sampleRate);
  const { lowBand, highBand } = selectionBandRange(selection, spec.numBands);
  if (endFrame <= startFrame || highBand < lowBand) return null;

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

  const textureWidth = Math.min(spec.textureWidth, total);
  const textureHeight = textureWidth > 0 ? Math.ceil(total / textureWidth) : 0;
  if (textureWidth <= 0 || textureHeight <= 0) return null;

  const packedData = new Float32Array(textureWidth * textureHeight * 4);
  const inverseMap = new Float32Array(textureWidth * textureHeight * 2);
  for (let i = 0; i < textureWidth * textureHeight; i++) {
    inverseMap[i * 2 + 1] = numBands - 1;
  }

  for (let band = 0; band < numBands; band++) {
    const step = 1 << bandStepLog2s[band];
    const length = bandLengths[band];
    const sourceOffset = spec.synthesisMetadata.bandOffsets[band];
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
      const from = (sourceOffset + sourceBin) * 4;
      packedData.set(data.subarray(from, from + 4), target * 4);
    }
  }

  const metadata = new Float32Array(numBands * 4);
  for (let band = 0; band < numBands; band++) {
    metadata[band * 4] = bandOffsets[band];
    metadata[band * 4 + 1] = bandLengths[band];
    metadata[band * 4 + 2] = bandStepLog2s[band];
    // The frequencies are the source file's, unchanged.
    metadata[band * 4 + 3] = spec.metadata[band * 4 + 3];
  }

  return {
    spec: {
      packedData,
      inverseMap,
      metadata,
      textureWidth,
      textureHeight,
      numFrames: clipFrames,
      numBands,
      numChannels,
      sampleRate,
      packedTextureSize: new Vector2(textureWidth, textureHeight),
      minFreq,
      bandsPerOctave,
      magnitudeEnergy: spec.magnitudeEnergy,
      synthesisMetadata: { bandOffsets, bandStepLog2s, bandLengths },
    },
    rect: selection,
    originFrame,
    sourceName,
  };
}

/**
 * Where a drop lands, as the rectangle the pasted sound will occupy. The
 * clipboard keeps its own size, so only the corner moves.
 */
export function dropRect(clipboard: ClipboardRegion, aimTimeSeconds: number, aimPitchUv: number): Selection {
  const { rect } = clipboard;
  return {
    start: aimTimeSeconds,
    end: aimTimeSeconds + (rect.end - rect.start),
    pitchLo: aimPitchUv,
    pitchHi: aimPitchUv + (rect.pitchHi - rect.pitchLo),
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
