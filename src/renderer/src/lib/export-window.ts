import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat, type WebGLRenderer } from "three";
import { blockGrid, type BlockGrid } from "./block-grid";
import type { CanvasView } from "./canvas-view";
import type { BlockValueReader } from "./canvas-window";
import type { ExportSpan, ExportWindow } from "./image-export";
import { PackedWindow } from "./packed-window";
import type { SpectrogramData } from "@renderer/store/types";
import { metadataTextureRows } from "./band-layout";

/**
 * Serves an image export spans of a file's committed state, for a canvas that
 * holds only a window of it. Each span is a run of blocks composed into one
 * texture with its own band layout, so the export shader reads it exactly as
 * it reads a whole file.
 */
export class ExportSourceWindow implements ExportWindow {
  readonly spanFrames: number;
  private readonly window: PackedWindow;
  private metadata: DataTexture | null = null;
  private laidOut: CanvasView | null = null;

  constructor(gl: WebGLRenderer, grid: BlockGrid, opts: { windowBlocks: number; read: BlockValueReader }) {
    this.window = new PackedWindow(gl, grid, opts);
    const blocks = Math.min(Math.max(1, opts.windowBlocks), grid.blockCount);
    // A span this long falls inside `blocks` blocks wherever it starts. A whole
    // window is one block longer, but only a span that starts on a block edge
    // can use all of it.
    this.spanFrames = Math.max(1, blocks - 1) * grid.blockFrames;
  }

  async hold(startFrame: number, endFrame: number): Promise<ExportSpan | null> {
    const view = this.window.plan(startFrame, endFrame);
    if (!(await this.window.hold(view))) return null;
    if (this.laidOut !== view) {
      this.metadata?.dispose();
      this.metadata = metadataTexture(view);
      this.laidOut = view;
    }
    if (!this.metadata) return null;
    return {
      texture: this.window.texture,
      metadataTexture: this.metadata,
      startFrame: view.startFrame,
      endFrame: view.endFrame,
    };
  }

  dispose(): void {
    this.metadata?.dispose();
    this.metadata = null;
    this.laidOut = null;
    this.window.dispose();
  }
}

/** The block grid a file's export spans are cut on. */
export function exportBlockGrid(spectrogram: SpectrogramData): BlockGrid {
  const { numBands, metadata, numFrames, sampleRate } = spectrogram;
  return blockGrid({ numBands, metadata }, numFrames, sampleRate);
}

function metadataTexture(view: CanvasView): DataTexture {
  const { numBands } = view.layout;
  const texture = new DataTexture(metadataTextureRows(view.layout), numBands, 1, RGBAFormat, FloatType);
  texture.internalFormat = "RGBA32F";
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
