import { blockTexels, PACKED_BYTES_PER_TEXEL, type BlockGrid } from "./block-grid";
import {
  DISPLAY_PYRAMID_BYTES_PER_TEXEL,
  DISPLAY_PYRAMID_MAX_TEXELS,
  displayPyramidBudgetTexels,
} from "./display-pyramid";
import { displayTilesBytes } from "./display-tiles";
import { MAX_PACKED_TEXTURE_TEXELS } from "./constants";
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
// RAM one packed coefficient costs at the peak of an open, over the flat cost
// below. Every pass that reads the file now takes it a chunk at a time, so what
// is left growing with length is the audio: the decoded samples the analysis
// reads and the buffer the file plays from. Five- and ten-minute opens measured
// 2.3 bytes a coefficient between them, and this leaves well over double.
const ANALYSIS_BYTES_PER_TEXEL = 6;
// RAM those passes hold whatever the file's length: the chunk each reads, the
// blocks that stay decoded, and the canvas window. The same two opens put it at
// 441 MB on a 24 GB machine, where the caches are at their widest.
const ANALYSIS_FIXED_BYTES = 512 * 1024 * 1024;
// Share of the machine's memory one analysis may hold at its peak.
const ANALYSIS_MEMORY_SHARE = 0.25;
// Fraction of the GPU pool the spectrogram data may claim; the rest stays for
// the compositor, other apps, and everything else the app allocates.
const GPU_BUDGET_SHARE = 0.5;

/** Slots a block window keeps beyond the window itself, so a window the brush comes back to is still resident. */
export const CANVAS_WINDOW_SPARE_BLOCKS = 4;
/**
 * Block windows a windowed canvas keeps slots for: one for the canvas, one
 * for a stroke's paint on blocks that left it, and one for the original.
 */
const CANVAS_WINDOW_SLOT_WINDOWS = 3;
/** Spare slots the three windows keep between them. */
const CANVAS_WINDOW_SPARE_SLOTS = 3 * CANVAS_WINDOW_SPARE_BLOCKS;
/** Bytes a stroke's paint slot holds a texel in: its packed values and one mask weight. */
const PAINT_SLOT_BYTES_PER_TEXEL = PACKED_BYTES_PER_TEXEL + 2;
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
  // A window pays the whole-file rate over the window instead of the file —
  // the ping-pong pair, an inverse map and the original — plus the slots.
  const perTexel =
    GPU_BYTES_PER_TEXEL_FILE + GPU_BYTES_PER_TEXEL_SCRATCH + PACKED_BYTES_PER_TEXEL * CANVAS_WINDOW_SLOT_WINDOWS;
  return perTexel * window + windowSlotSpareBytes(texelsPerBlock);
}

/** Bytes the slots the three windows keep beyond the windows themselves hold. */
function windowSlotSpareBytes(texelsPerBlock: number): number {
  return PACKED_BYTES_PER_TEXEL * CANVAS_WINDOW_SPARE_SLOTS * texelsPerBlock;
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
 *
 * A file with more coefficients than one texture holds never keeps the whole
 * file, whatever the budget or the build says: the canvas is a texture pair,
 * and neither the budget nor a pinned figure can make one larger.
 */
export function canvasWindowBlocks(grid: BlockGrid): number {
  const texelsPerBlock = blockTexels(grid, 0);
  if (texelsPerBlock <= 0) return Infinity;
  const mustWindow = fileTexels(grid) > MAX_PACKED_TEXTURE_TEXELS;
  if (Number.isFinite(envWindowBlocks) && envWindowBlocks >= 1) return Math.floor(envWindowBlocks);
  if (Number.isFinite(envWindowBlocks) && !mustWindow) return Infinity;
  const info = gpuMemoryInfo();
  const budget = canvasWindowBudgetBytes();
  // Nothing to size a window against, so the smallest usable one it is.
  if (budget <= 0) return CANVAS_WINDOW_MIN_BLOCKS;
  // The whole file on the canvas needs no block slots, so a file that fits
  // keeps it, and behaves exactly as it did before windows existed.
  const wholeRate =
    GPU_BYTES_PER_TEXEL_FILE + GPU_BYTES_PER_TEXEL_SCRATCH + (info.unified ? CPU_BYTES_PER_TEXEL_FILE : 0);
  if (!mustWindow && wholeRate * fileTexels(grid) <= budget) return Infinity;
  const spare = windowSlotSpareBytes(texelsPerBlock);
  const blocks = Math.floor((budget - spare) / (canvasWindowBytes(1, texelsPerBlock) - spare));
  if (!mustWindow && blocks >= grid.blockCount) return Infinity;
  return Math.min(CANVAS_WINDOW_MAX_BLOCKS, grid.blockCount, Math.max(CANVAS_WINDOW_MIN_BLOCKS, blocks));
}

/**
 * Block slots the canvas window keeps beyond its window and its spares, out
 * of what the window's share of the budget has left once the window is sized:
 * a block that keeps its slot composes on the graphics device when the window
 * comes back to it, rather than being read and uploaded again. Never more than
 * the file has blocks. Zero for a file the canvas holds whole.
 */
export function canvasExtraSlotBlocks(grid: BlockGrid, windowBlocks: number): number {
  const texelsPerBlock = blockTexels(grid, 0);
  if (!Number.isFinite(windowBlocks) || texelsPerBlock <= 0) return 0;
  const left = canvasWindowBudgetBytes() - canvasWindowBytes(windowBlocks, texelsPerBlock);
  const extra = Math.floor(left / (PACKED_BYTES_PER_TEXEL * texelsPerBlock));
  const unclaimed = grid.blockCount - windowBlocks - CANVAS_WINDOW_SPARE_BLOCKS;
  return Math.max(0, Math.min(extra, unclaimed));
}

/**
 * Slots a stroke's paint on blocks that left the window may take beyond a
 * window and its spares: what the window's share has left once the block
 * slots have theirs, up to the rest of the file. A stroke that paints more
 * blocks than these hold keeps the oldest in RAM instead. Zero for a file the
 * canvas holds whole.
 */
export function canvasPaintExtraSlotBlocks(grid: BlockGrid, windowBlocks: number): number {
  const texelsPerBlock = blockTexels(grid, 0);
  if (!Number.isFinite(windowBlocks) || texelsPerBlock <= 0) return 0;
  const left =
    canvasWindowBudgetBytes() -
    canvasWindowBytes(windowBlocks, texelsPerBlock) -
    canvasExtraSlotBlocks(grid, windowBlocks) * PACKED_BYTES_PER_TEXEL * texelsPerBlock;
  const extra = Math.floor(left / (PAINT_SLOT_BYTES_PER_TEXEL * texelsPerBlock));
  return Math.max(0, Math.min(extra, grid.blockCount - windowBlocks - CANVAS_WINDOW_SPARE_BLOCKS));
}

/** True when the painting canvas holds every block of a file cut on `grid`, so none of it is paged. */
export function canvasHoldsWholeFile(grid: BlockGrid): boolean {
  return grid.blockCount <= canvasWindowBlocks(grid);
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

/** Packed coefficients a file may hold, from the RAM opening one costs at its peak. */
export function analysisPeakTexels(): number {
  const share = host.os.totalmem() * ANALYSIS_MEMORY_SHARE - ANALYSIS_FIXED_BYTES;
  return Math.max(0, Math.floor(share / ANALYSIS_BYTES_PER_TEXEL));
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

/** What one open file holds, in packed texels. */
export interface OpenFileTexels {
  /** Texels the file's analysed state has. */
  file: number;
  /** Texels the canvas lays out: the file's own, or a window's. */
  canvas: number;
  /** Texels one block holds, or zero while the canvas holds the whole file. */
  block: number;
  /** Slots the block and paint slots keep beyond their windows and spares, from `canvasExtraSlotBlocks` and `canvasPaintExtraSlotBlocks`. */
  extraSlots?: number;
}

/** Display textures one open file holds. Both are bounded, whatever its length. */
function displayBytes(fileTexels: number): number {
  return displayPyramidBudgetTexels(fileTexels) * DISPLAY_PYRAMID_BYTES_PER_TEXEL + displayTilesBytes();
}

/**
 * What one open file holds beyond its display textures and the shared scratch:
 * the canvas and the textures behind it, the block slots when it paints
 * through a window, and the CPU copies when it does not.
 */
function fileResidentBytes(file: OpenFileTexels, unified: boolean): number {
  const bytes = GPU_BYTES_PER_TEXEL_FILE * file.canvas;
  if (file.block <= 0) return bytes + (unified ? CPU_BYTES_PER_TEXEL_FILE * file.file : 0);
  const slots = CANVAS_WINDOW_SLOT_WINDOWS * file.canvas + (file.extraSlots ?? 0) * file.block;
  return bytes + PACKED_BYTES_PER_TEXEL * slots + windowSlotSpareBytes(file.block);
}

/** Bytes the open files hold, by the same rates the budget is spent at. */
export function spectrogramBytes(open: OpenFileTexels[], unified: boolean): number {
  let bytes = 0;
  let scratch = 0;
  for (const file of open) {
    bytes += fileResidentBytes(file, unified) + displayBytes(file.file);
    scratch = Math.max(scratch, GPU_BYTES_PER_TEXEL_SCRATCH * file.canvas);
  }
  // No open file, no history manager, so nothing holds the caches yet.
  const overhead = unified && open.length > 0 ? historyCacheBytes() : 0;
  return bytes + scratch + overhead;
}

/**
 * Share of the spectrogram memory budget the open files hold, as 0..1 — what
 * the menu bar reports. Undefined when the host names no GPU memory figure,
 * which leaves no budget to measure against.
 */
export function usedBudgetFraction(open: OpenFileTexels[]): number | undefined {
  const info = gpuMemoryInfo();
  if (info.bytes <= 0) return undefined;
  const budget = info.bytes * GPU_BUDGET_SHARE;
  return spectrogramBytes(open, info.unified) / budget;
}

/**
 * Largest packed coefficient count one more analysis may produce, given what
 * the files already open hold. A file that will paint through a window costs
 * the graphics device the same however long it is, so what limits it is the
 * RAM the analysis itself holds at its peak. Undefined when the host names no
 * GPU memory figure, which leaves no graphics budget to measure against.
 */
export function remainingCoefficientBudget(open: OpenFileTexels[]): number | undefined {
  const info = gpuMemoryInfo();
  if (info.bytes <= 0) return undefined;

  const perTexel = GPU_BYTES_PER_TEXEL_FILE + (info.unified ? CPU_BYTES_PER_TEXEL_FILE : 0);
  let budget = info.bytes * GPU_BUDGET_SHARE - (info.unified ? historyCacheBytes() : 0);

  let largest = 0;
  for (const file of open) {
    largest = Math.max(largest, file.canvas);
    budget -= fileResidentBytes(file, info.unified) + displayBytes(file.file);
  }
  // The display textures of the file about to open, charged at their cap:
  // both are bounded, so a longer file does not take more of the budget.
  budget -= DISPLAY_PYRAMID_MAX_TEXELS * DISPLAY_PYRAMID_BYTES_PER_TEXEL + displayTilesBytes();

  const window = canvasWindowBudgetBytes();
  if (window > 0 && budget - GPU_BYTES_PER_TEXEL_SCRATCH * largest >= window) return analysisPeakTexels();

  // The new file has to fit whole. Within the scratch the open files already
  // pay for, or growing the pool with it.
  const withinPool = (budget - GPU_BYTES_PER_TEXEL_SCRATCH * largest) / perTexel;
  const growsPool = budget / (perTexel + GPU_BYTES_PER_TEXEL_SCRATCH);
  const allowed = growsPool > largest ? growsPool : Math.max(0, withinPool);
  return Math.floor(allowed);
}
