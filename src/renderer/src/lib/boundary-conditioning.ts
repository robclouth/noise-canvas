import type { FileRendererHandle } from "@renderer/components/file-renderer";
import type { StrokeCommitSnapshot } from "./stroke-commit";
import { host } from "./host";

// A hard-edged stroke leaves the coefficients around its time boundaries
// carrying orphaned cross-boundary tails: content just outside the footprint
// rings back into it (a pre-tail before audio comes back in) and the stamp's
// own content rings out of it. The addon computes the time-domain-exact
// boundary — interior content confined to the footprint, exterior content
// excluded from it — and returns the re-analyzed margin coefficients as a
// patch. See ConditionBoundaryWorker in gaborator-addon.cpp.

// Time-envelope curve above which a stamp edge counts as hard. The envelope
// curve runs -100 (spike) to +100 (rectangle); soft edges have no
// discontinuity to fix and keep the plain coefficient boundary.
const HARD_EDGE_CURVE_MIN = 80;

/**
 * Runs boundary conditioning for the snapshot's stroke, patching `data` in
 * place and pushing the patched coefficients to the GPU. Returns the patched
 * pixel ranges as a flat [pixelStart, pixelCount, ...] list for widening the
 * history delta, or null when conditioning did not apply (soft envelope, wrap,
 * stale stroke, or an empty patch). Widens `snapshot.dirtyRegion` to cover the
 * margins the patch reaches into.
 */
export async function conditionStrokeBoundary(
  renderer: FileRendererHandle,
  snapshot: StrokeCommitSnapshot,
  data: Float32Array,
): Promise<Uint32Array | null> {
  const { spec, curveTime, wrapMode, footprintUv } = snapshot;

  if (curveTime < HARD_EDGE_CURVE_MIN) return null;
  // A footprint that wraps the time axis has no in-file edges to condition.
  if (wrapMode === 1 || wrapMode === 3) return null;
  if (!footprintUv) return null;

  const { numFrames, numBands } = spec;
  const startFrame = Math.round(footprintUv.timeMin * numFrames);
  const endFrame = Math.round(footprintUv.timeMax * numFrames);
  if (endFrame <= startFrame) return null;
  // Both edges on the file boundary: nothing to condition.
  if (startFrame <= 0 && endFrame >= numFrames) return null;

  const bandLo = Math.max(0, Math.floor((1 - footprintUv.pitchMax) * numBands));
  const bandHi = Math.min(numBands - 1, Math.floor((1 - footprintUv.pitchMin) * numBands));

  const meta = {
    numFrames,
    numChannels: spec.numChannels,
    numBands,
    bandOffsets: spec.synthesisMetadata.bandOffsets,
    bandStepLog2s: spec.synthesisMetadata.bandStepLog2s,
    bandLengths: spec.synthesisMetadata.bandLengths,
  };

  const condStart = performance.now();
  const patch = await host.analysis.conditionBoundary(
    data,
    meta,
    spec.sampleRate,
    { bandsPerOctave: spec.bandsPerOctave, minFreq: spec.minFreq },
    { startFrame, endFrame, bandLo, bandHi },
  );
  console.log(
    `[timing] conditionBoundary: ${(performance.now() - condStart).toFixed(2)}ms (${patch.ranges.length / 3} band ranges)`,
  );
  if (!patch.ranges.length) return null;
  // A new stroke began while the patch was computed; applying it would write
  // over dabs the readback never saw. Leave everything as painted.
  if (renderer.getStrokeGeneration() !== snapshot.strokeGeneration) return null;

  const { ranges, pixels } = patch;
  const { bandOffsets, bandStepLog2s } = spec.synthesisMetadata;
  const pixelRanges = new Uint32Array((ranges.length / 3) * 2);
  let srcOffset = 0;
  let minFrameTouched = Infinity;
  let maxFrameTouched = -Infinity;
  let minBandTouched = Infinity;
  let maxBandTouched = -Infinity;
  for (let i = 0; i < ranges.length; i += 3) {
    const band = ranges[i];
    const k0 = ranges[i + 1];
    const count = ranges[i + 2];
    const pixelStart = bandOffsets[band] + k0;
    data.set(pixels.subarray(srcOffset, srcOffset + count * 4), pixelStart * 4);
    srcOffset += count * 4;
    pixelRanges[(i / 3) * 2] = pixelStart;
    pixelRanges[(i / 3) * 2 + 1] = count;

    const stepLog2 = bandStepLog2s[band];
    minFrameTouched = Math.min(minFrameTouched, k0 << stepLog2);
    maxFrameTouched = Math.max(maxFrameTouched, (k0 + count) << stepLog2);
    minBandTouched = Math.min(minBandTouched, band);
    maxBandTouched = Math.max(maxBandTouched, band);
  }

  const uploadStart = performance.now();
  renderer.patchFBOData(data, pixelRanges);
  console.log(`[timing] conditioning FBO upload: ${(performance.now() - uploadStart).toFixed(2)}ms`);
  // The patch reaches beyond the painted rect (time margins plus a spectral
  // skirt); synthesis must cover it or the audio misses the conditioning.
  expandSnapshotRegion(
    snapshot,
    Math.max(0, minFrameTouched / numFrames),
    Math.min(1, maxFrameTouched / numFrames),
    1 - (maxBandTouched + 1) / numBands,
    1 - minBandTouched / numBands,
  );
  return pixelRanges;
}

function expandSnapshotRegion(
  snapshot: StrokeCommitSnapshot,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
): void {
  const region = snapshot.dirtyRegion;
  if (!region) {
    snapshot.dirtyRegion = { startX, endX, startY, endY };
    return;
  }
  region.startX = Math.min(region.startX, startX);
  region.endX = Math.max(region.endX, endX);
  region.startY = Math.min(region.startY, startY);
  region.endY = Math.max(region.endY, endY);
}
