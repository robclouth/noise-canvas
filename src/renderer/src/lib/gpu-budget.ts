import { blockTexels, PACKED_BYTES_PER_TEXEL, type BlockGrid } from "./block-grid";
import {
  DISPLAY_PYRAMID_BYTES_PER_TEXEL,
  DISPLAY_PYRAMID_MAX_TEXELS,
  displayPyramidBudgetTexels,
} from "./display-pyramid";
import { displayTilesBytes } from "./display-tiles";
import { historyCacheBudgets } from "./history-cache-budgets";
import { host } from "./host";

// GPU bytes per packed texel one open file keeps resident: two ping-pong FBOs
// (2 × RGBA32F = 32), the pristine packed texture (RGBA32F = 16) and the
// inverse map (RG32F = 8).
export const GPU_BYTES_PER_TEXEL_FILE = 56;
// The shared stroke scratch pool at its fullest, sized to the largest open
// file: two pass FBOs (32), the stroke-start snapshot (16), one mask per brush
// step (MAX_STEPS × R16F = 10) and the two-target modulator buffer
// (2 × RGBA16F = 16). The pass FBOs, the masks and the modulator buffer are
// allocated on first use, but a brush can ask for them at any time, so the
// budget is charged for them from the start.
export const GPU_BYTES_PER_TEXEL_SCRATCH = 74;
// CPU-side copies (packedData 16, inverseMap 8); they compete with the
// textures only on unified-memory GPUs.
export const CPU_BYTES_PER_TEXEL_FILE = 24;
// Fraction of the GPU pool the spectrogram data may claim; the rest stays for
// the compositor, other apps, and everything else the app allocates.
const GPU_BUDGET_SHARE = 0.5;

/** Slots a block window keeps beyond the window itself, so a window the brush comes back to is still resident. */
export const CANVAS_WINDOW_SPARE_BLOCKS = 4;
/** Block windows a windowed canvas keeps slots for: two for the canvas, one for the original. */
const CANVAS_WINDOW_SLOT_WINDOWS = 3;
/** Spare slots the canvas window and the original window keep between them. */
const CANVAS_WINDOW_SPARE_SLOTS = 2 * CANVAS_WINDOW_SPARE_BLOCKS;
// GPU bytes per texel of a canvas window: the ping-pong pair (2 × RGBA32F =
// 32), the view's inverse map (RG32F = 8) and the window over the original
// (RGBA32F = 16). The same rate a whole-file canvas pays, over the window
// instead of the file.
export const GPU_BYTES_PER_TEXEL_WINDOW = 56;
/** Share of the spectrogram budget one file's painting canvas may hold. */
const CANVAS_WINDOW_SHARE = 0.35;
// Blocks a window holds at least. Under this the brush outruns the canvas on
// every phrase, so the floor wins over the budget on a device too small for
// it: the alternative is a window nobody can paint on.
const CANVAS_WINDOW_MIN_BLOCKS = 4;
/** Blocks a window holds at most; past this the slides it saves cost more than they are worth. */
const CANVAS_WINDOW_MAX_BLOCKS = 16;

const envWindowBlocks = Number(import.meta.env.VITE_CANVAS_WINDOW_BLOCKS);

/**
 * GPU bytes a file's canvas costs as a window of `blocks` blocks, each holding
 * `blockTexels` packed texels: the canvas, the window over the original, the
 * stroke scratch, and the block slots behind both windows.
 */
export function canvasWindowBytes(blocks: number, texelsPerBlock: number): number {
  const window = blocks * texelsPerBlock;
  const perTexel =
    GPU_BYTES_PER_TEXEL_WINDOW + GPU_BYTES_PER_TEXEL_SCRATCH + PACKED_BYTES_PER_TEXEL * CANVAS_WINDOW_SLOT_WINDOWS;
  return perTexel * window + PACKED_BYTES_PER_TEXEL * CANVAS_WINDOW_SPARE_SLOTS * texelsPerBlock;
}

/** GPU bytes one file's painting canvas may hold. Zero when the host names no GPU figure. */
export function canvasWindowBudgetBytes(): number {
  const info = gpuMemoryInfo();
  return info.bytes > 0 ? info.bytes * GPU_BUDGET_SHARE * CANVAS_WINDOW_SHARE : 0;
}

/** Packed texels a file's whole analysed state holds, padding excluded. */
function fileTexels(grid: BlockGrid): number {
  const { metadata, numBands } = grid.layout;
  let texels = 0;
  for (let band = 0; band < numBands; band++) texels += metadata[band * 4 + 1];
  return texels;
}

/**
 * Blocks the painting canvas holds for a file cut on `grid`, or `Infinity`
 * when the whole file fits the budget — which is every file short enough that
 * a window would save nothing. A build pins the figure with
 * `VITE_CANVAS_WINDOW_BLOCKS`, where 0 keeps the whole file on the canvas.
 */
export function canvasWindowBlocks(grid: BlockGrid): number {
  if (Number.isFinite(envWindowBlocks)) return envWindowBlocks >= 1 ? Math.floor(envWindowBlocks) : Infinity;
  const texelsPerBlock = blockTexels(grid, 0);
  if (texelsPerBlock <= 0) return Infinity;
  const info = gpuMemoryInfo();
  const budget = canvasWindowBudgetBytes();
  // Nothing to size a window against, so the smallest usable one it is.
  if (budget <= 0) return CANVAS_WINDOW_MIN_BLOCKS;
  // The whole file on the canvas needs no block slots, so a file that fits
  // keeps it, and behaves exactly as it did before windows existed.
  const wholeRate =
    GPU_BYTES_PER_TEXEL_FILE + GPU_BYTES_PER_TEXEL_SCRATCH + (info.unified ? CPU_BYTES_PER_TEXEL_FILE : 0);
  if (wholeRate * fileTexels(grid) <= budget) return Infinity;
  const spare = PACKED_BYTES_PER_TEXEL * CANVAS_WINDOW_SPARE_SLOTS * texelsPerBlock;
  const blocks = Math.floor((budget - spare) / (canvasWindowBytes(1, texelsPerBlock) - spare));
  if (blocks >= grid.blockCount) return Infinity;
  return Math.min(CANVAS_WINDOW_MAX_BLOCKS, grid.blockCount, Math.max(CANVAS_WINDOW_MIN_BLOCKS, blocks));
}

let cachedInfo: { bytes: number; unified: boolean } | null = null;
let cachedHistoryBytes: number | null = null;

/** The GPU's memory figure, queried once per session. Zero bytes when the host names none. */
export function gpuMemoryInfo(): { bytes: number; unified: boolean } {
  if (cachedInfo) return cachedInfo;
  const analysis = host.analysis;
  if (!analysis || typeof analysis.getGpuMemoryInfo !== "function") return { bytes: 0, unified: false };
  cachedInfo = analysis.getGpuMemoryInfo();
  return cachedInfo;
}

/**
 * RAM the history caches may hold — stroke deltas, hop audio and resident
 * packed blocks. A flat overhead, not a per-texel rate: the budgets are the
 * same whatever length is open, and painting fills them.
 */
export function historyCacheBytes(): number {
  if (cachedHistoryBytes === null) {
    const budgets = historyCacheBudgets(host.os.totalmem());
    cachedHistoryBytes = budgets.deltas + budgets.audioHops + budgets.blockResident;
  }
  return cachedHistoryBytes;
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
  // No open file, no history manager, so nothing holds the caches yet.
  const overhead = unified && openTexelCounts.length > 0 ? historyCacheBytes() : 0;
  let displays = 0;
  for (const texels of openTexelCounts) {
    displays += displayPyramidBudgetTexels(texels) * DISPLAY_PYRAMID_BYTES_PER_TEXEL + displayTilesBytes();
  }
  return perTexel * sum + GPU_BYTES_PER_TEXEL_SCRATCH * largest + overhead + displays;
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
  let budget = info.bytes * GPU_BUDGET_SHARE - (info.unified ? historyCacheBytes() : 0);

  let sum = 0;
  let largest = 0;
  for (const texels of openTexelCounts) {
    sum += texels;
    largest = Math.max(largest, texels);
    budget -= displayPyramidBudgetTexels(texels) * DISPLAY_PYRAMID_BYTES_PER_TEXEL + displayTilesBytes();
  }
  // The display textures of the file about to open, charged at their cap:
  // both are bounded, so a longer file does not take more of the budget.
  budget -= DISPLAY_PYRAMID_MAX_TEXELS * DISPLAY_PYRAMID_BYTES_PER_TEXEL + displayTilesBytes();

  // A new file within the current pool size pays only the per-file rate; a
  // larger one also grows the scratch pool with it.
  const withinPool = (budget - perTexel * sum - GPU_BYTES_PER_TEXEL_SCRATCH * largest) / perTexel;
  const growsPool = (budget - perTexel * sum) / (perTexel + GPU_BYTES_PER_TEXEL_SCRATCH);
  const allowed = growsPool > largest ? growsPool : Math.max(0, withinPool);
  return Math.floor(allowed);
}
