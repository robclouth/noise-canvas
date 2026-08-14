import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat } from "three";

/**
 * Onset map for a file. The addon detects onsets from the packed coefficients
 * and reports every plausible peak with a raw salience and no threshold; this
 * is where the file's sensitivity decides which of them count, and where the
 * survivors are baked into a 1-row float texture mapping any time position to
 * its onset neighbourhood: R = nearest onset time in seconds, G = 1 where an
 * onset exists, B = the previous onset time (at or before the position, −1
 * when none), A = the next onset time (−1 when none). Transient-aware effects
 * re-anchor phase at the nearest onset, and the transform's rigid transient
 * re-read spans the stretch between the two neighbours, all from one fetch.
 *
 * The cutoff is hard: an onset either counts or it does not, and one that
 * counts is re-anchored in full whether it is a kick or a ghost note — the
 * point of the treatment is that the moment is an attack, not that it is loud.
 */

export type Onset = { timeSec: number; strength: number };

const BIN_SEC = 0.001;
const MAX_TEX_WIDTH = 4096;
// Percentile of the file's saliences that maps to full strength. Taken high
// rather than at the maximum so one outlier hit does not scale everything else
// down, and as a level rather than a rank so a loop of equal hits keeps them
// all at full strength.
const REFERENCE_PERCENTILE = 0.9;
// The quiet end of the same scale. Together with the reference these span the
// range of level the file actually contains, so the control divides up what is
// there rather than a fixed span most material does not fill.
const FLOOR_PERCENTILE = 0.1;
// Bounds on that span. Below the minimum, a loop whose hits are all within a
// couple of decibels would have those differences stretched across the whole
// control and read as meaningful; above the maximum, one distant hit would push
// everything else into the top of the range together.
const MIN_RANGE_DB = 12;
const MAX_RANGE_DB = 48;

/**
 * Applies a sensitivity (0..100) to the addon's raw onsets (flat
 * [time, salience] pairs): every onset whose strength reaches 1 − s/100
 * survives. Salience is an amplitude, so the control works in decibels below
 * the file's reference level: an even slider travel then covers an even span
 * of level, where dividing the amplitudes directly would spend most of the
 * travel on the loudest few decibels.
 */
export function filterOnsets(packed: Float32Array | undefined, sensitivity: number): Onset[] {
  if (!packed || packed.length < 2) return [];

  const count = packed.length >> 1;
  const saliences = new Float64Array(count);
  for (let i = 0; i < count; i++) saliences[i] = packed[i * 2 + 1];

  const sorted = Float64Array.from(saliences).sort();
  const at = (p: number): number => sorted[Math.min(count - 1, Math.floor((count - 1) * p))];
  const reference = at(REFERENCE_PERCENTILE);
  if (!(reference > 0)) return [];
  const floor = Math.max(at(FLOOR_PERCENTILE), reference * 1e-4);
  const rangeDb = Math.min(MAX_RANGE_DB, Math.max(MIN_RANGE_DB, 20 * Math.log10(reference / floor)));

  const threshold = 1 - sensitivity / 100;
  const onsets: Onset[] = [];
  for (let i = 0; i < count; i++) {
    if (!(saliences[i] > 0)) continue;
    const db = 20 * Math.log10(saliences[i] / reference);
    const strength = Math.min(1, Math.max(0, 1 + db / rangeDb));
    // The first event in a file is where its material begins, so it is kept at
    // any sensitivity: it competes with nothing, and everything painted at the
    // head of the file anchors to it.
    if (strength < threshold && onsets.length > 0) continue;
    onsets.push({ timeSec: packed[i * 2], strength });
  }
  return onsets;
}

export type OnsetReference = { odfMax: number; bandMax: Float32Array };
export type OnsetState = { onsets: Float32Array; reference?: OnsetReference };

/**
 * A file's onsets and the reference they were found against, as one array for
 * storage: [odfMax, band count, each band's maximum…, then the onset pairs].
 * Detection is a function of the coefficients, so what is stored belongs to the
 * history node whose coefficients it describes.
 */
export function packOnsetState(state: OnsetState): Float32Array {
  const bandMax = state.reference?.bandMax ?? new Float32Array(0);
  const out = new Float32Array(2 + bandMax.length + state.onsets.length);
  out[0] = state.reference?.odfMax ?? 0;
  out[1] = bandMax.length;
  out.set(bandMax, 2);
  out.set(state.onsets, 2 + bandMax.length);
  return out;
}

export function unpackOnsetState(raw: Float32Array): OnsetState | null {
  if (raw.length < 2) return null;
  const bandCount = raw[1];
  if (!Number.isFinite(bandCount) || bandCount < 0 || 2 + bandCount > raw.length) return null;
  const bandMax = raw.slice(2, 2 + bandCount);
  const onsets = raw.slice(2 + bandCount);
  const odfMax = raw[0];
  return { onsets, reference: odfMax > 0 && bandMax.length > 0 ? { odfMax, bandMax } : undefined };
}

/**
 * Replaces the onsets between `startSec` and `endSec` with a freshly detected
 * set for that span, keeping the rest of the file's as they were. A stroke only
 * changes its own span, so that is the only part worth detecting again.
 * Both lists are the detector's flat [time, salience] pairs, in time order.
 */
export function spliceOnsets(
  existing: Float32Array | undefined,
  replacement: Float32Array,
  startSec: number,
  endSec: number,
): Float32Array {
  if (!existing || existing.length < 2) return replacement.slice();

  const before: number[] = [];
  const after: number[] = [];
  for (let i = 0; i + 1 < existing.length; i += 2) {
    const timeSec = existing[i];
    if (timeSec < startSec) before.push(timeSec, existing[i + 1]);
    else if (timeSec >= endSec) after.push(timeSec, existing[i + 1]);
  }

  const out = new Float32Array(before.length + replacement.length + after.length);
  out.set(before, 0);
  out.set(replacement, before.length);
  out.set(after, before.length + replacement.length);
  return out;
}

/**
 * Bakes the onset-neighbourhood lookup row. Onsets must be sorted by time,
 * which is how the detector reports them.
 */
export function bakeOnsetTexture(onsets: Onset[], durationSec: number): DataTexture {
  const width = Math.max(1, Math.min(MAX_TEX_WIDTH, Math.ceil(durationSec / BIN_SEC)));
  const data = new Float32Array(width * 4);

  if (onsets.length > 0) {
    let prev = -1;
    for (let x = 0; x < width; x++) {
      const t = ((x + 0.5) / width) * durationSec;
      while (prev < onsets.length - 1 && onsets[prev + 1].timeSec <= t) prev++;
      const prevTime = prev >= 0 ? onsets[prev].timeSec : -1;
      const nextTime = prev + 1 < onsets.length ? onsets[prev + 1].timeSec : -1;
      // Nearest of the two neighbours; a tie goes to the later one.
      let nearest: number;
      if (prevTime < 0) nearest = nextTime;
      else if (nextTime < 0) nearest = prevTime;
      else nearest = nextTime - t <= t - prevTime ? nextTime : prevTime;
      data[x * 4] = nearest;
      data[x * 4 + 1] = 1;
      data[x * 4 + 2] = prevTime;
      data[x * 4 + 3] = nextTime;
    }
  }

  const texture = new DataTexture(data, width, 1, RGBAFormat, FloatType);
  texture.internalFormat = "RGBA32F";
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

type CacheEntry = { packed: Float32Array | undefined; sensitivity: number; durationSec: number; texture: DataTexture };

const textureCache = new Map<string, CacheEntry>();

type ListCacheEntry = { packed: Float32Array | undefined; sensitivity: number; onsets: Onset[] };

const listCache = new Map<string, ListCacheEntry>();

/**
 * The surviving onsets for a file, cached against its raw onsets and its
 * sensitivity. Cursor snapping and brush sizing ask for this on every mouse
 * move and every frame, which is too often to re-filter.
 */
export function getFilteredOnsets(fileId: string, packed: Float32Array | undefined, sensitivity: number): Onset[] {
  const cached = listCache.get(fileId);
  if (cached && cached.packed === packed && cached.sensitivity === sensitivity) return cached.onsets;

  const onsets = filterOnsets(packed, sensitivity);
  listCache.set(fileId, { packed, sensitivity, onsets });
  return onsets;
}

/**
 * The baked map for a file, rebuilt when its onsets, its length, or the
 * sensitivity change. Released by disposeOnsetTexture when the file closes.
 */
export function getOnsetTexture(
  fileId: string,
  packed: Float32Array | undefined,
  durationSec: number,
  sensitivity: number,
): DataTexture {
  const cached = textureCache.get(fileId);
  if (cached && cached.packed === packed && cached.sensitivity === sensitivity && cached.durationSec === durationSec) {
    return cached.texture;
  }
  cached?.texture.dispose();

  const texture = bakeOnsetTexture(getFilteredOnsets(fileId, packed, sensitivity), durationSec);
  textureCache.set(fileId, { packed, sensitivity, durationSec, texture });
  return texture;
}

export function disposeOnsetTexture(fileId: string): void {
  listCache.delete(fileId);
  const cached = textureCache.get(fileId);
  if (!cached) return;
  cached.texture.dispose();
  textureCache.delete(fileId);
}
