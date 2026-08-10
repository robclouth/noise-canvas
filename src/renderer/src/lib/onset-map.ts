import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat } from "three";

/**
 * Onset map for a file. The addon detects onsets from the packed coefficients
 * and reports every plausible peak with a raw salience and no threshold; this
 * is where the sensitivity control decides which of them count, and where the
 * survivors are baked into a 1-row float texture mapping any time position to
 * its nearest onset: R = onset time in seconds, G = strength 0..1 (BA unused).
 * Transient-aware effects re-anchor phase at the mapped onset with a single
 * texture fetch.
 */

export type Onset = { timeSec: number; strength: number };

const BIN_SEC = 0.001;
const MAX_TEX_WIDTH = 4096;
// Half-width of the threshold's soft knee. Onsets fade in and out as the
// sensitivity slider passes them instead of popping, which matters because a
// dropped onset changes how the shader treats a whole attack.
const KNEE = 0.1;
// Percentile of the file's saliences that maps to full strength. Taken high
// rather than at the maximum so one outlier hit does not scale everything else
// down, and as a level rather than a rank so a loop of equal hits keeps them
// all at full strength.
const REFERENCE_PERCENTILE = 0.9;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(edge1 - edge0, 1e-9)));
  return t * t * (3 - 2 * t);
}

/**
 * Applies the sensitivity control to the addon's raw onsets (flat
 * [time, salience] pairs). Sensitivity runs 0..100; the survivors carry a
 * strength that also expresses how confident the detection was.
 */
export function filterOnsets(packed: Float32Array | undefined, sensitivity: number): Onset[] {
  if (!packed || packed.length < 2) return [];

  const count = packed.length >> 1;
  const saliences = new Float64Array(count);
  for (let i = 0; i < count; i++) saliences[i] = packed[i * 2 + 1];

  const sorted = Float64Array.from(saliences).sort();
  const reference = sorted[Math.min(count - 1, Math.floor((count - 1) * REFERENCE_PERCENTILE))];
  if (!(reference > 0)) return [];

  const threshold = 1 - sensitivity / 100;
  const onsets: Onset[] = [];
  for (let i = 0; i < count; i++) {
    const normalized = Math.min(1, saliences[i] / reference);
    const gain = smoothstep(threshold - KNEE, threshold + KNEE, normalized);
    if (gain <= 0) continue;
    onsets.push({ timeSec: packed[i * 2], strength: gain * normalized });
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
      data[x * 4 + 1] = onsets[cursor].strength;
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
