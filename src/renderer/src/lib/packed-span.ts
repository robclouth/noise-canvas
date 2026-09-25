import type { SpectrogramData } from "../store/types";
import { blockGrid, blockOfFrame } from "./block-grid";
import { canvasViewOf, wholeFileCanvasView, type CanvasView } from "./canvas-view";

/** The committed pixels of a file over a block-aligned frame span, laid out as the span's view lays them. */
export class PackedSpan {
  constructor(
    readonly view: CanvasView,
    readonly values: Float32Array,
  ) {}

  /** A span over the whole file, from the file's whole packed run. */
  static whole(
    spec: Pick<SpectrogramData, "numBands" | "metadata" | "numFrames" | "sampleRate">,
    packed: Float32Array,
  ) {
    return new PackedSpan(wholeFileCanvasView(spec), packed);
  }

  /** The index in `values` of `band`'s absolute bin `bin`, in pixels; -1 when the span does not hold it. */
  pixel(band: number, bin: number): number {
    const { metadata } = this.view.layout;
    const k = bin - this.view.bandK0[band];
    if (k < 0 || k >= metadata[band * 4 + 1]) return -1;
    return metadata[band * 4] + k;
  }
}

/**
 * Reads the committed state over the blocks covering [startFrame, endFrame)
 * through `read`, the file's committed-pixel reader. Null when the store
 * cannot serve them.
 */
export async function readPackedSpan(
  spec: Pick<SpectrogramData, "numBands" | "metadata" | "numFrames" | "sampleRate">,
  startFrame: number,
  endFrame: number,
  read: (ranges: Uint32Array) => Promise<Float32Array | null>,
): Promise<PackedSpan | null> {
  const grid = blockGrid({ numBands: spec.numBands, metadata: spec.metadata }, spec.numFrames, spec.sampleRate);
  const first = blockOfFrame(grid, Math.max(0, Math.min(spec.numFrames - 1, startFrame)));
  const last = blockOfFrame(grid, Math.max(0, Math.min(spec.numFrames - 1, endFrame - 1)));
  const view = canvasViewOf(grid, first, Math.max(first, last));
  const values = await read(view.ranges);
  return values ? new PackedSpan(view, values) : null;
}
