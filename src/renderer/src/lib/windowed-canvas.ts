import { Vector2, type WebGLRenderer } from "three";
import type { SpectrogramData } from "../store/types";
import { blockGrid, blockOfFrame, blocksForPixelRanges } from "./block-grid";
import {
  clipRangesToView,
  composeViewContent,
  fileUvToViewUv,
  viewCoversFile,
  viewRangesToFile,
  viewUvToFileUv,
  type CanvasView,
} from "./canvas-view";
import { CANVAS_WINDOW_BLOCKS, CanvasWindow, needsCanvasWindow, type BlockValueReader } from "./canvas-window";
import { CarriedPaint, carryPaintOut, dropReturningPaint, type PaintBox } from "./carried-paint";
import { PackedWindow } from "./packed-window";
import { composePixelRangeValues, gatherPixelRanges, mergePixelRanges } from "./pixel-ranges";
import type { StrokeRenderer } from "./stroke-renderer";

/** A rectangle of the file in unpacked UV, as the dirty region is kept. */
export type UvRegion = { startX: number; endX: number; startY: number; endY: number };

/** What a windowed canvas needs from its owner. */
export type WindowedCanvasDeps = {
  gl: WebGLRenderer;
  spectrogram: SpectrogramData;
  /** The live renderer, or null while the owner is between renderers. */
  renderer: () => StrokeRenderer | null;
  /** The file's committed pixels, by file-absolute range. */
  readCurrent: BlockValueReader;
  /** The file's original pixels — what the store was seeded with. */
  readRoot: BlockValueReader;
  /** Called when the canvas or the display picture changed. */
  onChanged: () => void;
  /** Blocks the canvas holds at once. Defaults to the build's setting. */
  windowBlocks?: number;
};

/**
 * The file-space face of the painting canvas.
 *
 * A canvas may hold the whole file or one window of it. This owns everything
 * that difference costs: the block window the canvas paints through, a second
 * window over the file's original, and the paint carried off blocks that leave
 * the window mid-stroke. Every method here speaks the file's coordinates. When
 * the canvas covers the whole file, each one passes straight through to the
 * renderer, so the whole-file path stays exactly what it was.
 *
 * The rules the rest of the app relies on:
 *
 * 1. A dab never lands on a block the canvas has no content for — `holdsFrames`
 *    says when it may. Painting over an empty block would commit silence.
 * 2. The canvas and the original move together. The canvas slides only once
 *    both windows have their blocks.
 * 3. Paint on a block that leaves the window mid-stroke is carried, and the
 *    commit reads the carry as well as the canvas.
 * 4. Any move of the whole state (a history hop, a restore, phase turns)
 *    installs a fresh carry, because the old one no longer speaks for the file.
 */
export class WindowedCanvas {
  private readonly deps: WindowedCanvasDeps;
  private readonly numFrames: number;
  private readonly blocks: CanvasWindow | null;
  private readonly original: PackedWindow | null;
  private request: CanvasView | null = null;
  private carried = new CarriedPaint();
  private stroking = false;

  constructor(deps: WindowedCanvasDeps) {
    this.deps = deps;
    this.numFrames = deps.spectrogram.numFrames;
    const { numBands, metadata, sampleRate, numFrames } = deps.spectrogram;
    const windowBlocks = deps.windowBlocks ?? CANVAS_WINDOW_BLOCKS;
    const grid = blockGrid({ numBands, metadata }, numFrames, sampleRate);
    if (needsCanvasWindow(grid, windowBlocks)) {
      this.blocks = new CanvasWindow(deps.gl, grid, { windowBlocks, read: deps.readCurrent });
      this.original = new PackedWindow(deps.gl, grid, { windowBlocks, read: deps.readRoot });
    } else {
      this.blocks = null;
      this.original = null;
    }
  }

  /** True when this file is short enough for the canvas to hold all of it. */
  get wholeFile(): boolean {
    return this.blocks === null;
  }

  /** True while the canvas as it stands holds every frame of the file. */
  coversFile(): boolean {
    const view = this.view();
    return view === null || viewCoversFile(view, this.numFrames);
  }

  /** The span the canvas textures lay out, or undefined when they hold the file. */
  span(): CanvasView | undefined {
    const view = this.view();
    return view && !viewCoversFile(view, this.numFrames) ? view : undefined;
  }

  /** The view a renderer for this file should start on, or undefined for the whole file. */
  firstView(startFrame: number, endFrame: number): CanvasView | undefined {
    return this.blocks?.plan(null, startFrame, endFrame);
  }

  /**
   * Fills the canvas for the first time: the blocks already in slots go on
   * now, the picture of the rest of the file comes from `seed`, and the window
   * reads whatever is still missing.
   */
  initialize(seed: Float32Array | null): void {
    const renderer = this.deps.renderer();
    if (!renderer) return;
    const window = this.blocks;
    if (!window) {
      renderer.initialize();
      return;
    }
    const view = renderer.committedSource().view;
    window.clearCanvas();
    renderer.initialize((target) => {
      const cold = new Set(window.composeResident(view, target));
      window.markOnCanvas(window.blocksOf(view).filter((block) => !cold.has(block)));
    });
    // The canvas holds one window, so the picture of the rest of the file
    // comes from the analysed state rather than from the canvas.
    if (seed) renderer.seedDisplayFromPacked(seed);
    this.aim(view.startFrame, view.endFrame);
  }

  /**
   * Points the canvas at the frames [startFrame, endFrame). Blocks it lacks
   * are read in the background and taken when they land, so a brush ahead of
   * the reads keeps painting on what the canvas already holds. The original
   * window reads alongside, so it never lays out a span the canvas has left.
   */
  aim(startFrame: number, endFrame: number): void {
    const window = this.blocks;
    const renderer = this.deps.renderer();
    if (!window || !renderer?.getIsInitialized()) return;
    const current = renderer.committedSource().view;
    const next = window.plan(current, startFrame, endFrame);
    const originalHeld = this.original?.holds(next) ?? true;
    if (next === current && window.canvasLacks(next).length === 0 && originalHeld) return;
    const pending = this.request;
    if (pending && pending.firstBlock === next.firstBlock && pending.lastBlock === next.lastBlock) return;
    this.request = next;
    const original = this.original;
    const reads = Promise.all([window.acquire(next), original ? original.hold(next) : Promise.resolve(true)]);
    void reads.then(([filled, originalFilled]) => {
      if (this.request !== next) return;
      this.request = null;
      const live = this.deps.renderer();
      if (!filled || !originalFilled || !live?.getIsInitialized()) return;
      if (original) live.setOriginalTexture(original.texture);
      const held = live.committedSource().view;
      if (held.firstBlock !== next.firstBlock || held.lastBlock !== next.lastBlock) {
        if (this.stroking) this.carryPaintOff(live, next);
        live.slideView(next, (target, blocks) => window.compose(next, blocks, target), { midStroke: this.stroking });
        window.markSlid(next, held);
        if (this.stroking) dropReturningPaint(this.carried, window, next, held);
      }
      // Whatever the canvas still lacks: the blocks a slide did not bring in,
      // and the ones an abandoned fill left empty. Nothing painted is drawn
      // over, because a dab never lands on a block the canvas lacks.
      const view = live.committedSource().view;
      const lacking = window.canvasLacks(view);
      if (lacking.length > 0) {
        live.fillCanvas((target) => window.compose(view, lacking, target));
        window.markOnCanvas(lacking);
      }
      this.deps.onChanged();
    });
  }

  /**
   * True while the canvas holds content for every block of [startFrame,
   * endFrame) its view covers. A dab blends out of the canvas, so one landing
   * on a block with no content would paint silence and commit it.
   */
  holdsFrames(startFrame: number, endFrame: number): boolean {
    const window = this.blocks;
    if (!window) return true;
    const view = this.view();
    if (!view) return false;
    const first = Math.max(view.firstBlock, blockOfFrame(window.grid, startFrame));
    const last = Math.min(view.lastBlock, blockOfFrame(window.grid, Math.max(startFrame, endFrame - 1)));
    return window.canvasLacks({ firstBlock: first, lastBlock: last }).length === 0;
  }

  /** The brush origin in the canvas's own UV. */
  dabCursor(cursorPos: Vector2): Vector2 {
    const view = this.view();
    if (!view || this.coversFile()) return cursorPos;
    return new Vector2(fileUvToViewUv(view, this.numFrames, cursorPos.x), cursorPos.y);
  }

  /** The seconds the canvas's own UV spans. */
  dabDuration(totalDuration: number): number {
    const view = this.view();
    if (!view || this.coversFile()) return totalDuration;
    return (view.endFrame - view.startFrame) / this.deps.spectrogram.sampleRate;
  }

  beginStroke(): void {
    this.stroking = true;
    // A fresh carry per stroke, so a commit still reading the last one keeps it.
    this.carried = new CarriedPaint();
    this.deps.renderer()?.beginStroke();
  }

  endStroke(): void {
    this.stroking = false;
    this.deps.renderer()?.endStroke();
  }

  // ---------- reading the state, in file coordinates ----------

  /** The whole packed state, or null when the canvas holds only part of the file. */
  async getFBOData(): Promise<Float32Array | null> {
    const renderer = this.expectRenderer();
    if (!this.coversFile()) return null;
    return await renderer.getFBOData();
  }

  /** The named file pixels, taken from the canvas and from what it carried off. */
  async readPixelRanges(pixelRanges: Uint32Array): Promise<Float32Array> {
    const renderer = this.expectRenderer();
    if (this.coversFile()) return await renderer.readPixelRanges(pixelRanges);
    // Taken before the first await: a stroke starting now installs its own.
    const carried = this.carried;
    const clipped = clipRangesToView(renderer.committedSource().view, this.layout(), pixelRanges);
    const inView = await renderer.readPixelRanges(clipped.viewRanges);
    if (clipped.covered) return inView;
    // What the canvas no longer holds was carried off it as the window slid.
    await carried.settled();
    return composePixelRangeValues(pixelRanges, [carried.snapshot(), { ranges: clipped.fileRanges, values: inView }]);
  }

  /** The stroke's committed footprint as file pixel ranges, carry included. */
  dirtyPixelRanges(): Uint32Array | null {
    const renderer = this.deps.renderer();
    const ranges = renderer?.getDirtyPixelRanges() ?? null;
    if (!renderer || this.coversFile()) return ranges;
    const inView = ranges ? viewRangesToFile(renderer.committedSource().view, ranges) : null;
    const carried = this.carried.ranges();
    if (carried.length === 0) return inView;
    return inView ? mergePixelRanges(inView, carried) : carried;
  }

  /** The stroke's committed footprint in the file's UV, carry included. */
  committedFootprintUv(): PaintBox | null {
    const renderer = this.deps.renderer();
    const footprint = renderer?.getCommittedFootprintUv() ?? null;
    if (!renderer || this.coversFile()) return footprint;
    const inView = footprint && { ...footprint, ...this.boxToFileUv(footprint) };
    const carried = this.carried.paintBox();
    if (!carried) return inView;
    if (!inView) return carried;
    return {
      timeMin: Math.min(inView.timeMin, carried.timeMin),
      timeMax: Math.max(inView.timeMax, carried.timeMax),
      pitchMin: Math.min(inView.pitchMin, carried.pitchMin),
      pitchMax: Math.max(inView.pitchMax, carried.pitchMax),
    };
  }

  /** A dirty region the renderer keeps, in the file's UV. */
  regionToFileUv(region: UvRegion | null): UvRegion | null {
    const view = this.view();
    if (!region || !view || this.coversFile()) return region;
    return {
      ...region,
      startX: viewUvToFileUv(view, this.numFrames, region.startX),
      endX: viewUvToFileUv(view, this.numFrames, region.endX),
    };
  }

  /** Widens the dirty region, given file UV. */
  expandDirtyRegion(startX: number, endX: number, startY: number, endY: number): void {
    const renderer = this.deps.renderer();
    if (!renderer) return;
    const view = this.view();
    if (!view || this.coversFile()) {
      renderer.expandDirtyRegion(startX, endX, startY, endY);
      return;
    }
    renderer.expandDirtyRegion(
      fileUvToViewUv(view, this.numFrames, startX),
      fileUvToViewUv(view, this.numFrames, endX),
      startY,
      endY,
    );
  }

  // ---------- moving the state ----------

  /** Puts a whole packed state on the canvas. Returns false with no renderer. */
  setFBOData(data: Float32Array): boolean {
    const renderer = this.deps.renderer();
    if (!renderer) return false;
    if (this.coversFile()) {
      renderer.setFBOData(data);
      return true;
    }
    const view = renderer.committedSource().view;
    renderer.setFBOData(composeViewContent(view, data));
    renderer.seedDisplayFromPacked(data);
    renderer.getDisplayTiles()?.dropTiles(this.fullFilePixelRanges());
    const window = this.blocks;
    window?.invalidate();
    // The whole view was written, so the canvas lacks none of it.
    window?.markOnCanvas(window.blocksOf(view));
    this.carried = new CarriedPaint();
    return true;
  }

  /** Puts the named file pixels of `data` on the canvas. */
  patchFBOData(data: Float32Array, pixelRanges: Uint32Array): boolean {
    const renderer = this.deps.renderer();
    if (!renderer) return false;
    if (this.coversFile()) {
      renderer.patchFBOData(data, pixelRanges);
      return true;
    }
    const clipped = clipRangesToView(renderer.committedSource().view, this.layout(), pixelRanges);
    renderer.patchFBODataCompact(gatherPixelRanges(data, clipped.fileRanges), clipped.viewRanges);
    this.patchOutside(renderer, gatherPixelRanges(data, pixelRanges), pixelRanges);
    return true;
  }

  /** Puts compact values for the named file pixels on the canvas. */
  patchFBODataCompact(values: Float32Array, pixelRanges: Uint32Array): boolean {
    const renderer = this.deps.renderer();
    if (!renderer) return false;
    if (this.coversFile()) {
      renderer.patchFBODataCompact(values, pixelRanges);
      return true;
    }
    const clipped = clipRangesToView(renderer.committedSource().view, this.layout(), pixelRanges, values);
    if (clipped.viewValues) renderer.patchFBODataCompact(clipped.viewValues, clipped.viewRanges);
    this.patchOutside(renderer, values, pixelRanges);
    return true;
  }

  /** Turns phase over the named file pixels. */
  applyPhaseTurns(turns: ArrayLike<number>): boolean {
    const renderer = this.deps.renderer();
    if (!renderer) return false;
    if (this.coversFile()) {
      renderer.applyPhaseTurns(turns);
      return true;
    }
    const view = renderer.committedSource().view;
    const layout = this.layout();
    const translated: number[] = [];
    for (let i = 0; i + 3 < turns.length; i += 4) {
      const clipped = clipRangesToView(view, layout, Uint32Array.of(turns[i], turns[i + 1]));
      for (let j = 0; j + 1 < clipped.viewRanges.length; j += 2) {
        translated.push(clipped.viewRanges[j], clipped.viewRanges[j + 1], turns[i + 2], turns[i + 3]);
      }
    }
    renderer.applyPhaseTurns(translated);
    // Turns move phase, which the display does not show, but the slots still
    // hold the untorned values for the blocks they carry.
    const window = this.blocks;
    if (window) {
      const turned: number[] = [];
      for (let i = 0; i + 3 < turns.length; i += 4) turned.push(turns[i], turns[i + 1]);
      window.invalidate(blocksForPixelRanges(window.grid, Uint32Array.from(turned)));
    }
    this.carried = new CarriedPaint();
    return true;
  }

  dispose(): void {
    this.blocks?.dispose();
    this.original?.dispose();
    this.request = null;
  }

  // ---------- inside ----------

  private view(): CanvasView | null {
    return this.deps.renderer()?.committedSource().view ?? null;
  }

  private expectRenderer(): StrokeRenderer {
    const renderer = this.deps.renderer();
    if (!renderer) throw new Error("StrokeRenderer not initialized");
    return renderer;
  }

  private layout(): { numBands: number; metadata: Float32Array } {
    return { numBands: this.deps.spectrogram.numBands, metadata: this.deps.spectrogram.metadata };
  }

  private boxToFileUv(box: PaintBox): { timeMin: number; timeMax: number } {
    const view = this.view();
    if (!view) return { timeMin: box.timeMin, timeMax: box.timeMax };
    return {
      timeMin: viewUvToFileUv(view, this.numFrames, box.timeMin),
      timeMax: viewUvToFileUv(view, this.numFrames, box.timeMax),
    };
  }

  /** Every packed pixel of the file, as one range per band. */
  private fullFilePixelRanges(): Uint32Array {
    const { numBands, metadata } = this.deps.spectrogram;
    const ranges = new Uint32Array(numBands * 2);
    for (let band = 0; band < numBands; band++) {
      ranges[band * 2] = metadata[band * 4];
      ranges[band * 2 + 1] = metadata[band * 4 + 1];
    }
    return ranges;
  }

  /**
   * Carries a change the canvas cannot hold all of to the rest of the file:
   * the display picture takes the new values, the block slots forget the
   * blocks they held, and the ring lets go of the tiles over them.
   */
  private patchOutside(renderer: StrokeRenderer, values: Float32Array, fileRanges: Uint32Array): void {
    renderer.patchDisplayFromCompact(values, fileRanges);
    renderer.getDisplayTiles()?.dropTiles(fileRanges);
    const window = this.blocks;
    if (window) window.invalidate(blocksForPixelRanges(window.grid, fileRanges));
    // The state moved, so paint carried off the canvas no longer speaks for
    // it. A commit already reading the old carry keeps the object it took.
    this.carried = new CarriedPaint();
  }

  /**
   * Keeps what the stroke painted on the blocks about to leave the canvas: the
   * block slots take the painted texels so a window coming back shows them,
   * the display picture takes them so they stay on screen, and the carry holds
   * them for the commit.
   */
  private carryPaintOff(renderer: StrokeRenderer, next: CanvasView): void {
    const window = this.blocks;
    if (!window) return;
    const carried = carryPaintOut(renderer, window, this.carried, next, this.numFrames);
    if (!carried) return;
    void carried.read.then((values) => {
      if (this.deps.renderer() !== renderer) return;
      renderer.patchDisplayFromCompact(values, carried.fileRanges);
      renderer.getDisplayTiles()?.dropTiles(carried.fileRanges);
      this.deps.onChanged();
    });
  }
}
