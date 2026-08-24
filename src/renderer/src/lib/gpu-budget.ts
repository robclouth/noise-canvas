import { host } from "./host";

// GPU bytes per packed texel one open file keeps resident: two ping-pong FBOs
// (2 × RGBA32F = 32), the pristine packed texture (RGBA32F = 16) and the
// inverse map (RG32F = 8). Charged per texel of the resident window, which is
// the whole file until paging moves it.
export const GPU_BYTES_PER_TEXEL_FILE = 56;
// The decimated whole-file overview, RG16F.
export const GPU_BYTES_PER_TEXEL_OVERVIEW = 4;
// The shared stroke scratch pool at its fullest, sized to the largest open
// file: two pass FBOs (32), the stroke-start snapshot (16), two masks
// (R16F = 4) and the two-target modulator buffer (2 × RGBA16F = 16). The pass
// FBOs and the modulator buffer are allocated on first use, but a brush can ask
// for them at any time, so the budget is charged for them from the start.
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

/** What one open file costs, split by the count each rate applies to. */
export interface FileFootprint {
  /** Packed texels the file has. The CPU copies are held for all of them. */
  fileTexels: number;
  /** Packed texels resident on the GPU. Equal to `fileTexels` until paging moves the window. */
  windowTexels: number;
  /** Texels the decimated overview holds. Zero before it is built. */
  overviewTexels: number;
}

/** A file with everything resident and no overview. */
export function wholeFileFootprint(fileTexels: number): FileFootprint {
  return { fileTexels, windowTexels: fileTexels, overviewTexels: 0 };
}

/** Bytes the open files hold, by the same rates the budget is spent at. */
export function spectrogramBytes(files: FileFootprint[], unified: boolean): number {
  let resident = 0;
  let largest = 0;
  let onCpu = 0;
  let overview = 0;
  for (const file of files) {
    resident += file.windowTexels;
    largest = Math.max(largest, file.windowTexels);
    onCpu += file.fileTexels;
    overview += file.overviewTexels;
  }
  return (
    GPU_BYTES_PER_TEXEL_FILE * resident +
    GPU_BYTES_PER_TEXEL_SCRATCH * largest +
    GPU_BYTES_PER_TEXEL_OVERVIEW * overview +
    (unified ? CPU_BYTES_PER_TEXEL_FILE * onCpu : 0)
  );
}

/**
 * Share of the spectrogram memory budget the open files hold, as 0..1 — what
 * the menu bar reports. Undefined when the host names no GPU memory figure,
 * which leaves no budget to measure against.
 */
export function usedBudgetFraction(files: FileFootprint[]): number | undefined {
  const info = gpuMemoryInfo();
  if (info.bytes <= 0) return undefined;
  const budget = info.bytes * GPU_BUDGET_SHARE;
  return spectrogramBytes(files, info.unified) / budget;
}

/**
 * Largest packed coefficient count one more analysis may produce, given the
 * texel counts of the files already open. Undefined when the host reports no
 * GPU memory figure, leaving only the analyzer's texture-dimension cap.
 *
 * Counted as if every file were resident whole, which is what an unpaged file
 * costs and an over-estimate for a paged one.
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
