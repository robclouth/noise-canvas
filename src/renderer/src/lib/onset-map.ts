import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat } from "three";

/**
 * Onset map for a file. The addon detects onsets from the packed coefficients
 * and reports every plausible peak with a raw salience and no threshold; this
 * is where the file's sensitivity decides which of them count, and where the
 * survivors are baked into a 1-row float texture mapping any time position to
 * its nearest onset: R = onset time in seconds, G = 1 where an onset exists,
 * B = how loud the event is 0..1 (A unused). Transient-aware effects re-anchor
 * phase at the mapped onset with a single texture fetch.
 *
 * The cutoff is hard: an onset either counts or it does not, and one that
 * counts is re-anchored in full whether it is a kick or a ghost note — the
 * point of the treatment is that the moment is an attack, not that it is loud.
 * The level only sets how brightly the marker is drawn.
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
    if (strength < threshold) continue;
    onsets.push({ timeSec: packed[i * 2], strength });
  }
  return onsets;
}

/**
 * Bakes a nearest-onset lookup row. Onsets must be sorted by time, which is how
 * the detector reports them.
 */
export function bakeOnsetTexture(onsets: Onset[], durationSec: number): DataTexture {
  const width = Math.max(1, Math.min(MAX_TEX_WIDTH, Math.ceil(durationSec / BIN_SEC)));
  const data = new Float32Array(width * 4);

  if (onsets.length > 0) {
    let cursor = 0;
    for (let x = 0; x < width; x++) {
      const t = ((x + 0.5) / width) * durationSec;
      while (
        cursor < onsets.length - 1 &&
        Math.abs(onsets[cursor + 1].timeSec - t) <= Math.abs(onsets[cursor].timeSec - t)
      ) {
        cursor++;
      }
      data[x * 4] = onsets[cursor].timeSec;
      data[x * 4 + 1] = 1;
      data[x * 4 + 2] = onsets[cursor].strength;
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

  const texture = bakeOnsetTexture(filterOnsets(packed, sensitivity), durationSec);
  textureCache.set(fileId, { packed, sensitivity, durationSec, texture });
  return texture;
}

export function disposeOnsetTexture(fileId: string): void {
  const cached = textureCache.get(fileId);
  if (!cached) return;
  cached.texture.dispose();
  textureCache.delete(fileId);
}
