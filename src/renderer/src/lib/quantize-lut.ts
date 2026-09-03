import { getNumberParameterDef, getQuantizeParamKey, parameterDefs } from "@renderer/parameters";
import { ParameterKey } from "@renderer/store/types";
import { DataTexture, FloatType, NearestFilter, RedFormat } from "three";

/** Texel range of one parameter's valid-value list inside the shared quantise texture. */
export type QuantizeListRange = { offset: number; count: number };

let listRanges: Map<ParameterKey, QuantizeListRange> | null = null;
let listData: Float32Array | null = null;
let listTexture: DataTexture | null = null;

// Sentinel marks (Grid/Brush spans, the 0 "Off" of rate sliders) sit outside
// [min, max], so the range filter drops them from the snap list.
function buildLists(): void {
  const ranges = new Map<ParameterKey, QuantizeListRange>();
  const values: number[] = [];

  for (const [key, def] of Object.entries(parameterDefs)) {
    if (def.kind !== "number" || !def.marks) continue;
    if (!getQuantizeParamKey(key as ParameterKey)) continue;

    const list = [...new Set(def.marks.map((mark) => mark.value))]
      .filter((value) => value >= def.min && value <= def.max)
      .sort((a, b) => a - b);
    if (list.length < 2) continue;

    ranges.set(key as ParameterKey, { offset: values.length, count: list.length });
    values.push(...list);
  }

  const data = new Float32Array(Math.max(values.length, 1));
  data.set(values);
  const texture = new DataTexture(data, data.length, 1, RedFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;

  listRanges = ranges;
  listData = data;
  listTexture = texture;
}

/** Texel range of `key`'s mark-value list, or null when it snaps by step instead. */
export function getQuantizeListRange(key: ParameterKey): QuantizeListRange | null {
  if (!listRanges) buildLists();
  return listRanges!.get(key) ?? null;
}

/** The shared 1×N texture holding every quantisable parameter's mark values. */
export function getQuantizeLutTexture(): DataTexture {
  if (!listTexture) buildLists();
  return listTexture!;
}

/**
 * Snaps `value` to `key`'s valid values in slider units, mirroring the shader:
 * the nearest mark where the slider has a list, the step grid otherwise.
 */
export function quantizeParameterValue(key: ParameterKey, value: number): number {
  const range = getQuantizeListRange(key);
  if (range && listData) {
    let best = listData[range.offset];
    let bestDist = Math.abs(value - best);
    for (let i = 1; i < range.count; i++) {
      const cand = listData[range.offset + i];
      const dist = Math.abs(value - cand);
      if (dist < bestDist) {
        bestDist = dist;
        best = cand;
      }
    }
    return best;
  }

  const def = getNumberParameterDef(key);
  const step = def.step ?? 0;
  if (step <= 0) return value;
  const snapped = def.min + Math.round((value - def.min) / step) * step;
  return Math.min(Math.max(snapped, def.min), def.max);
}
