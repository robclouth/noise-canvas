import type { WebGLRenderer } from "three";
import { openFiles } from "../store/files";
import { diag } from "./diag-log";
import { spectrogramBytes, usedBudgetFraction } from "./gpu-budget";
import { historyMemoryCacheBytes } from "./history-manager";
import { host } from "./host";
import { getStrokeScratchPool } from "./stroke-scratch-pool";

const SAMPLE_INTERVAL_MS = 10_000;
// A gap longer than this between rendered frames is the demand loop idling,
// not a slow frame, so it is left out of the cadence figures.
const IDLE_GAP_MS = 500;
const RING_SIZE = 2048;
// A memory line is written only when some figure moved by more than this
// share since the last one.
const CHANGE_FRACTION = 0.05;

const frameIntervals = new Float32Array(RING_SIZE);
let frameCount = 0;
let droppedFrames = 0;
let lastFrameAt = 0;
let strokes = 0;
let previews = 0;

/** Records one rendered frame; call once per frame from the render loop. */
export function recordDiagFrame(now: number): void {
  if (lastFrameAt > 0) {
    const gap = now - lastFrameAt;
    if (gap <= IDLE_GAP_MS) {
      if (frameCount < RING_SIZE) frameIntervals[frameCount++] = gap;
      else droppedFrames++;
    }
  }
  lastFrameAt = now;
}

/** Counts a stroke dispatch, preview or committed, for the next cadence line. */
export function countDiagStroke(preview: boolean): void {
  if (preview) previews++;
  else strokes++;
}

function percentile(sorted: Float32Array, fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index];
}

function logFrameCadence(): void {
  if (frameCount === 0 && strokes === 0 && previews === 0) return;
  const sorted = frameIntervals.slice(0, frameCount).sort();
  diag.info("frame", "cadence", {
    frames: frameCount + droppedFrames,
    p50Ms: Math.round(percentile(sorted, 0.5) * 10) / 10,
    p95Ms: Math.round(percentile(sorted, 0.95) * 10) / 10,
    maxMs: Math.round(percentile(sorted, 1) * 10) / 10,
    strokes,
    previews,
  });
  frameCount = 0;
  droppedFrames = 0;
  strokes = 0;
  previews = 0;
}

function openTexelCounts(): number[] {
  const counts: number[] = [];
  for (const file of Object.values(openFiles)) {
    const data = file.spectrogramData;
    if (data) counts.push(data.textureWidth * data.textureHeight);
  }
  return counts;
}

type MemoryFigures = Record<string, number>;

function changedBeyond(previous: MemoryFigures | null, next: MemoryFigures): boolean {
  if (!previous) return true;
  for (const [key, value] of Object.entries(next)) {
    const last = previous[key];
    if (last === undefined) return true;
    if (Math.abs(value - last) > Math.max(1, last) * CHANGE_FRACTION) return true;
  }
  return false;
}

const performanceWithMemory: Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } } =
  performance;

async function memoryFigures(gl: WebGLRenderer): Promise<MemoryFigures> {
  const toMB = (bytes: number): number => Math.round(bytes / 1048576);
  const texels = openTexelCounts();
  const unified = host.analysis.getGpuMemoryInfo().unified;
  const figures: MemoryFigures = {
    spectrogramMB: toMB(spectrogramBytes(texels, unified)),
    budgetPercent: Math.round((usedBudgetFraction(texels) ?? 0) * 100),
    scratchMB: toMB(getStrokeScratchPool(gl).allocatedBytes),
    openFiles: texels.length,
  };
  const history = historyMemoryCacheBytes();
  figures.historyPackedMB = toMB(history.packedStates);
  figures.historyDeltaMB = toMB(history.deltas);
  figures.historyHopMB = toMB(history.audioHops);
  const heap = performanceWithMemory.memory;
  if (heap) figures.jsHeapMB = toMB(heap.usedJSHeapSize);
  if (typeof process !== "undefined" && typeof process.getProcessMemoryInfo === "function") {
    const info = await process.getProcessMemoryInfo();
    figures.rendererPrivateMB = Math.round(info.private / 1024);
    figures.rendererSharedMB = Math.round(info.shared / 1024);
  }
  return figures;
}

/**
 * Writes a frame-cadence line and, when the figures moved, a memory line
 * every ten seconds. Returns a stop function.
 */
export function startDiagSampler(gl: WebGLRenderer): () => void {
  let lastFigures: MemoryFigures | null = null;
  let sampling = false;

  const sample = async (): Promise<void> => {
    if (sampling) return;
    sampling = true;
    try {
      logFrameCadence();
      const figures = await memoryFigures(gl);
      if (changedBeyond(lastFigures, figures)) {
        lastFigures = figures;
        diag.info("memory", "renderer", figures);
      }
    } catch (error) {
      diag.warn("memory", "sample failed", { error });
    } finally {
      sampling = false;
    }
  };

  void sample();
  const timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
  return () => clearInterval(timer);
}
