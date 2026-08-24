import { host } from "./host";

// GPU bytes per packed texel one open file keeps resident: two ping-pong FBOs
// (2 × RGBA32F = 32), the pristine packed texture (RGBA32F = 16) and the
// inverse map (RG32F = 8).
export const GPU_BYTES_PER_TEXEL_FILE = 56;
// The shared stroke scratch pool at its fullest, sized to the largest open
// file: two pass FBOs (32), the stroke-start snapshot (16), two masks
// (R16F = 4) and the two-target modulator buffer (2 × RGBA16F = 16).
export const GPU_BYTES_PER_TEXEL_SCRATCH = 68;
// CPU-side copies (packedData 16, inverseMap 8); they compete with the
// textures only on unified-memory GPUs.
const CPU_BYTES_PER_TEXEL_FILE = 24;
// Fraction of the GPU pool the spectrogram data may claim; the rest stays for
// the compositor, other apps, and everything else the app allocates.
const GPU_BUDGET_SHARE = 0.5;

let cachedInfo: { bytes: number; unified: boolean } | null = null;

/** The GPU's memory figure, queried once per session. */
export function gpuMemoryInfo(): { bytes: number; unified: boolean } {
  if (!cachedInfo) cachedInfo = host.analysis.getGpuMemoryInfo();
  return cachedInfo;
}

/** Bytes the open files hold, by the same rates the budget is spent at. */
export function spectrogramBytes(openTexelCounts: number[], unified: boolean): number {
  let sum = 0;
  let largest = 0;
  for (const texels of openTexelCounts) {
    sum += texels;
    largest = Math.max(largest, texels);
  }
  const perTexel = GPU_BYTES_PER_TEXEL_FILE + (unified ? CPU_BYTES_PER_TEXEL_FILE : 0);
  return perTexel * sum + GPU_BYTES_PER_TEXEL_SCRATCH * largest;
}

/**
 * Share of the spectrogram memory budget the open files hold, as 0..1 — what
 * the menu bar reports. Undefined when the host names no GPU memory figure,
 * which leaves no budget to measure against.
 */
export function usedBudgetFraction(openTexelCounts: number[]): number | undefined {
  const info = gpuMemoryInfo();
  if (info.bytes <= 0) return undefined;
  const budget = info.bytes * GPU_BUDGET_SHARE;
  return spectrogramBytes(openTexelCounts, info.unified) / budget;
}

/**
 * Largest packed coefficient count one more analysis may produce, given the
 * texel counts of the files already open. Undefined when the host reports no
 * GPU memory figure, leaving only the analyzer's texture-dimension cap.
 */
export function remainingCoefficientBudget(openTexelCounts: number[]): number | undefined {
  const info = gpuMemoryInfo();
  if (info.bytes <= 0) return undefined;

  const perTexel = GPU_BYTES_PER_TEXEL_FILE + (info.unified ? CPU_BYTES_PER_TEXEL_FILE : 0);
  const budget = info.bytes * GPU_BUDGET_SHARE;

  let sum = 0;
  let largest = 0;
  for (const texels of openTexelCounts) {
    sum += texels;
    largest = Math.max(largest, texels);
  }

  // A new file within the current pool size pays only the per-file rate; a
  // larger one also grows the scratch pool with it.
  const withinPool = (budget - perTexel * sum - GPU_BYTES_PER_TEXEL_SCRATCH * largest) / perTexel;
  const growsPool = (budget - perTexel * sum) / (perTexel + GPU_BYTES_PER_TEXEL_SCRATCH);
  const allowed = growsPool > largest ? growsPool : Math.max(0, withinPool);
  return Math.floor(allowed);
}
