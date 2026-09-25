import { Vector2, type WebGLRenderer } from "three";
import type { SpectrogramData } from "../store/types";
import type { BandLayout } from "./band-layout";
import {
  blockGrid,
  blockOfFrame,
  blockPixelRanges,
  blocksForPixelRanges,
  blockTexels,
  PACKED_BYTES_PER_TEXEL,
  type BlockGrid,
} from "./block-grid";
import {
  clipRangesToView,
  composeViewContent,
  fileRangesToView,
  fileUvToViewUv,
  viewCoversFile,
  viewRangesToFile,
  viewUvToFileUv,
  type CanvasView,
} from "./canvas-view";
import { CanvasWindow, type BlockReader, type BlockValueReader, type TapValueReader } from "./canvas-window";
import { canvasExtraSlotBlocks, canvasWindowBlocks, CANVAS_WINDOW_SPARE_BLOCKS } from "./gpu-budget";
import { CarriedPaint, carryPaintOut, dropReturningPaint, type PaintBox } from "./carried-paint";
import type { CoarseStrip } from "./coarse-strip";
import { diag } from "./diag-log";
import { PackedWindow } from "./packed-window";
import {
  composePixelRangeValues,
  copyTapsFromCompact,
  gatherPixelRanges,
  intersectPixelRanges,
  mergePixelRanges,
  pixelRangeCount,
  subtractPixelRanges,
  tapCount,
  tapSpanRanges,
} from "./pixel-ranges";
import { SourceWindowSlot, type SourceFileBlocks, type SourceNeed, type SourceWindowTextures } from "./source-window";
import type { StrokeRenderer } from "./stroke-renderer";

// Block reads kept in flight ahead of the block being drawn into the display.
const DISPLAY_DRAW_READ_AHEAD = 4;

/** A rectangle of the file in unpacked UV, as the dirty region is kept. */
export type UvRegion = { startX: number; endX: number; startY: number; endY: number };

export type { SourceNeed } from "./source-window";

/**
 * What a dab reads beyond the canvas: other files, each through a window
 * this canvas owns, and this file's original state.
 */
export type DabNeeds = { sources: readonly SourceNeed[]; impulses: readonly SourceNeed[]; original: boolean };

/** Paint waiting for the canvas to hold the frames it lands on. */
type HeldPaint = { startFrame: number; endFrame: number; needs: DabNeeds; paint: () => boolean };

/** A window the canvas is reading towards, and whether the original reads alongside. */
type WindowRequest = { view: CanvasView; original: boolean };

/** A stroke's paint by file range, held while its commit has still to store it. */
type PendingPaint = { ranges: Uint32Array; values: Float32Array | null; landed: Promise<void> };

export type StrokeSettlement =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; reason: "unavailable" | "read-error" };

/**
 * Bytes the canvas window's slots may hold: two windows, the spares, and the
 * slots the budget has left. A window spanning the whole file never slides,
 * so it keeps one window of slots.
 */
function canvasWindowSlotBytes(grid: BlockGrid, windowBlocks: number): number {
  const slots =
    windowBlocks >= grid.blockCount
      ? windowBlocks
      : 2 * windowBlocks + CANVAS_WINDOW_SPARE_BLOCKS + canvasExtraSlotBlocks(grid, windowBlocks);
  return slots * blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL;
}

/** Longest idle wait between two blocks the slot warm-up reads. */
const SLOT_WARM_STEP_MS = 50;
/** How long the warm-up waits while a stroke paints or a commit lands. */
const SLOT_WARM_RETRY_MS = 500;

/** Fills `settle` waits through before it gives up on the paint still held. */
const HELD_PAINT_FILLS = 8;

/** Drops the slots for files no need names any more. */
function dropExcept(slots: Map<string, SourceWindowSlot>, needs: readonly SourceNeed[]): void {
  const wanted = new Set(needs.map((need) => need.fileId));
  for (const [fileId, slot] of slots) {
    if (wanted.has(fileId)) continue;
    slot.dispose();
    slots.delete(fileId);
  }
}

/** What a windowed canvas needs from its owner. */
export type WindowedCanvasDeps = {
  gl: WebGLRenderer;
  spectrogram: SpectrogramData;
  /** The live renderer, or null while the owner is between renderers. */
  renderer: () => StrokeRenderer | null;
  /** The file's committed pixels, by file-absolute range. */
  readCurrent: BlockValueReader;
  /** The committed magnitudes at strided taps; without it, taps are picked out of `readCurrent`. */
  readCurrentTaps?: TapValueReader;
  /** The file's original pixels — what the store was seeded with. */
  readRoot: BlockValueReader;
  /** The committed pixels of one block, without the range read's copy. */
  readCurrentBlock?: BlockReader;
  /** The original pixels of one block, without the range read's copy. */
  readRootBlock?: BlockReader;
  /** Called when the canvas or the display picture changed. */
  onChanged: () => void;
  /** Another open file's blocks, for a brush painting from it. Null when it has none. */
  sourceBlocks: (fileId: string) => SourceFileBlocks | null;
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
 *    `paintWhenHeld` holds such a dab back and runs it, in the order it was
 *    given, once the canvas takes the block.
 * 2. The original is read only for a dab that samples it, through a window
 *    built on first use. Such a dab lands only once that window holds the
 *    canvas's view; a slide that no dab asked the original for leaves it.
 * 3. Paint on a block that leaves the window mid-stroke is carried, and the
 *    commit reads the carry as well as the canvas.
 * 4. Any move of the whole state (a history hop, a restore, phase turns)
 *    installs a fresh carry, because the old one no longer speaks for the file.
 * 5. A brush painting from another windowed file reads it through a window of
 *    this canvas's own, placed by the frames the dab asks for. That window
 *    holds the other file's committed state, so it re-reads when that state
 *    moves.
 */
export class WindowedCanvas {
  private readonly deps: WindowedCanvasDeps;
  private readonly numFrames: number;
  private readonly grid: BlockGrid;
  private readonly blocks: CanvasWindow;
  private original: PackedWindow | null = null;
  private readonly sources = new Map<string, SourceWindowSlot>();
  private readonly impulses = new Map<string, SourceWindowSlot>();
  private readonly windowBlocks: number;
  private request: WindowRequest | null = null;
  private fill: Promise<void> | null = null;
  private drawingStore: Promise<void> | null = null;
  private displaySeed: { edited: Uint32Array } | null = null;
  private generation = 0;
  private disposed = false;
  private readonly held: HeldPaint[] = [];
  private carried = new CarriedPaint();
  private readonly pending: PendingPaint[] = [];
  private stroking = false;
  // Set from `beginStroke` until the stroke ends or is discarded.
  private discardable = false;
  private warming = false;
  private strokeEpoch = 0;
  private cancelSettlement: (() => void) | null = null;

  constructor(deps: WindowedCanvasDeps) {
    this.deps = deps;
    this.numFrames = deps.spectrogram.numFrames;
    const { numBands, metadata, sampleRate, numFrames } = deps.spectrogram;
    const grid = blockGrid({ numBands, metadata }, numFrames, sampleRate);
    this.grid = grid;
    const windowBlocks = Math.min(deps.windowBlocks ?? canvasWindowBlocks(grid), grid.blockCount);
    this.blocks = new CanvasWindow(deps.gl, grid, {
      windowBlocks,
      maxBytes: canvasWindowSlotBytes(grid, windowBlocks),
      read: deps.readCurrent,
      readBlock: deps.readCurrentBlock,
    });
    this.windowBlocks = windowBlocks;
  }

  /** Changes when a stroke starts, is discarded, or its state is replaced. */
  get strokeRevision(): number {
    return this.strokeEpoch;
  }

  /** True when the window spans every block, so the canvas holds the whole file and never slides. */
  get holdsWholeFile(): boolean {
    return this.windowBlocks >= this.grid.blockCount;
  }

  /** True from `beginStroke` until the stroke ends or is discarded, while `discardStroke` can take it back. */
  get strokeDiscardable(): boolean {
    return this.discardable;
  }

  /** True between `beginStroke` and `endStroke`, while dabs are landing. */
  get isStroking(): boolean {
    return this.stroking;
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

  /** The view a renderer for this file should start on. */
  firstView(startFrame: number, endFrame: number): CanvasView {
    return this.blocks.plan(null, startFrame, endFrame);
  }

  /**
   * Fills the canvas for the first time. A `seed`, the whole current state an
   * analysis just returned, fills the canvas and the picture at once. Without
   * one the blocks already in slots go on now, the window reads whatever is
   * still missing, and the picture is drawn out of the store a block at a
   * time; `strip`, when the analysis kept one, shows the whole file at a
   * coarser level while that draw runs.
   */
  initialize(seed: Float32Array | null, strip: CoarseStrip | null = null): void {
    const renderer = this.deps.renderer();
    if (this.disposed || !renderer) return;
    this.generation++;
    this.drawingStore = null;
    this.displaySeed = null;
    const window = this.blocks;
    const view = renderer.committedSource().view;
    window.clearCanvas();
    renderer.initialize((target) => {
      const cold = new Set(window.composeResident(view, target));
      window.markOnCanvas(window.blocksOf(view).filter((block) => !cold.has(block)));
    });
    // A store with no root to read yet is drawn from once the owner has
    // written one.
    if (seed) {
      this.setFBOData(seed);
    } else {
      if (strip) renderer.seedDisplayFromStrip(strip);
      void this.drawDisplayFromStore();
    }
    this.aim(view.startFrame, view.endFrame);
  }

  /**
   * Fills the canvas and draws the file's picture, for a canvas built before
   * its store could answer. The store cannot serve a range until the root
   * snapshot naming its seed is written, so the fill and the picture the
   * constructor asked for both come back empty; without this the window's span
   * stays blank until something else aims the canvas.
   */
  async storeReady(): Promise<void> {
    const generation = this.generation;
    const renderer = this.deps.renderer();
    if (this.disposed || !renderer?.getIsInitialized()) return;
    await this.drawDisplayFromStore();
    if (this.disposed || generation !== this.generation || renderer !== this.deps.renderer()) return;
    if (!renderer.getIsInitialized()) return;
    const view = renderer.committedSource().view;
    this.aim(view.startFrame, view.endFrame);
    this.warmSlots();
  }

  /**
   * Fills free block slots from the store in idle time, nearest the canvas
   * first, so a window that later moves there composes on the GPU. It waits
   * while a stroke paints or a commit lands, and stops once every block has a
   * slot or no slot is free.
   */
  private warmSlots(): void {
    const window = this.blocks;
    if (this.warming || this.disposed || this.holdsWholeFile) return;
    this.warming = true;
    const started = performance.now();
    let warmed = 0;
    const later = (step: () => void, ms: number): void => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(step, { timeout: ms });
      else setTimeout(step, ms);
    };
    const step = (): void => {
      const renderer = this.deps.renderer();
      if (this.disposed || !renderer?.getIsInitialized()) {
        this.warming = false;
        return;
      }
      if (this.stroking || this.pending.length > 0 || this.fill || this.request) {
        later(step, SLOT_WARM_RETRY_MS);
        return;
      }
      const view = renderer.committedSource().view;
      window.warmOne(Math.round((view.firstBlock + view.lastBlock) / 2)).then(
        (took) => {
          if (took) {
            warmed++;
            later(step, SLOT_WARM_STEP_MS);
            return;
          }
          this.warming = false;
          if (warmed > 0) diag.timing("timing", "block slots warmed", performance.now() - started, { blocks: warmed });
        },
        () => {
          this.warming = false;
        },
      );
    };
    later(step, SLOT_WARM_STEP_MS);
  }

  /**
   * Draws the file's picture into the display a block at a time, for a file
   * whose owner holds no run of it to seed from. The picture fills in as the
   * blocks are read, a few reads in flight ahead of the block being drawn.
   */
  private drawDisplayFromStore(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.drawingStore) return this.drawingStore;
    const renderer = this.deps.renderer();
    if (!renderer?.getIsInitialized()) return Promise.resolve();
    const generation = this.generation;
    const current = (): boolean =>
      !this.disposed &&
      generation === this.generation &&
      renderer === this.deps.renderer() &&
      renderer.getIsInitialized();
    const seed: { edited: Uint32Array } = { edited: new Uint32Array(0) };
    for (const paint of this.pending) seed.edited = mergePixelRanges(seed.edited, paint.ranges);
    if (this.stroking) seed.edited = mergePixelRanges(seed.edited, this.dirtyPixelRanges() ?? new Uint32Array(0));
    this.displaySeed = seed;
    const { readCurrent, readCurrentBlock, readRoot, readRootBlock } = this.deps;
    const read = async (index: number): Promise<{ ranges: Uint32Array; values: Float32Array } | null> => {
      try {
        const list = blockPixelRanges(this.grid, index);
        const ranges = list.ranges.slice(0, list.count * 2);
        let values = await (readCurrentBlock ? readCurrentBlock(index) : readCurrent(ranges));
        if (!current()) return null;
        if (!values) {
          values = await (readRootBlock ? readRootBlock(index) : readRoot(ranges));
          if (!current()) return null;
        }
        return values ? { ranges, values } : null;
      } catch (error) {
        if (current()) diag.warn("gl", "display seed read failed", { error: String(error) });
        return null;
      }
    };
    const draw = async (): Promise<void> => {
      const count = this.grid.blockCount;
      const pending: Array<ReturnType<typeof read>> = [];
      try {
        for (let index = 0; index < Math.min(DISPLAY_DRAW_READ_AHEAD, count); index++) pending.push(read(index));
        let seeded = false;
        for (let index = 0; index < count; index++) {
          const block = await pending.shift()!;
          if (!current() || !block) return;
          if (index + DISPLAY_DRAW_READ_AHEAD < count) pending.push(read(index + DISPLAY_DRAW_READ_AHEAD));
          if (!seeded) {
            renderer.beginDisplaySeedFromStore();
            seeded = true;
          }
          // Newer display pixels survive even while their store commit is still pending.
          const ranges = seed.edited.length === 0 ? block.ranges : subtractPixelRanges(block.ranges, seed.edited);
          if (ranges.length > 0) {
            const values = seed.edited.length === 0 ? block.values : composePixelRangeValues(ranges, [block]);
            renderer.patchDisplayFromCompact(values, ranges);
          }
          this.deps.onChanged();
        }
        if (current()) renderer.finishDisplaySeed();
      } finally {
        await Promise.all(pending);
      }
    };
    const tracked = draw()
      .catch((error) => {
        if (current()) diag.warn("gl", "display seed failed", { error: String(error) });
      })
      .finally(() => {
        if (this.drawingStore === tracked) {
          this.drawingStore = null;
          this.displaySeed = null;
        }
      });
    this.drawingStore = tracked;
    return tracked;
  }

  /**
   * Points the canvas at the frames [startFrame, endFrame). Blocks it lacks
   * are read in the background and taken when they land, so a brush ahead of
   * the reads keeps painting on what the canvas already holds. With
   * `wantOriginal` the window over the original reads alongside and the
   * canvas takes both together. While a stroke has dabs waiting, the aim goes
   * to the oldest of them and the ones behind it that fit the same window,
   * not to the pointer: a target that moves every frame would supersede each
   * read before it landed, and the held paint would only ever land at the
   * commit.
   */
  aim(startFrame: number, endFrame: number, wantOriginal = false): void {
    const window = this.blocks;
    const renderer = this.deps.renderer();
    if (!renderer?.getIsInitialized()) return;
    if (this.stroking && this.held.length > 0) {
      const span = this.heldSpan();
      startFrame = span.startFrame;
      endFrame = span.endFrame;
      wantOriginal = wantOriginal || span.original;
    }
    const current = renderer.committedSource().view;
    const next = window.plan(current, startFrame, endFrame);
    const original = wantOriginal ? this.originalWindow() : null;
    const originalHeld = original ? original.holds(next) : true;
    if (next === current && window.canvasLacks(next).length === 0 && originalHeld) return;
    const pending = this.request;
    if (
      pending &&
      pending.view.firstBlock === next.firstBlock &&
      pending.view.lastBlock === next.lastBlock &&
      (pending.original || !original)
    ) {
      return;
    }
    const request: WindowRequest = { view: next, original: original !== null };
    this.request = request;
    // The carry's reads settle first, so a block coming back can take its
    // paint out of the carry as soon as it is composed.
    const reads = Promise.all([
      window.acquire(next),
      original ? original.hold(next) : Promise.resolve(true),
      this.carried.settled(),
      ...this.pending.map((paint) => paint.landed),
    ]);
    const filling = reads.then(([filled, originalFilled]) => {
      if (this.request !== request) return;
      this.request = null;
      const live = this.deps.renderer();
      if (!filled || !originalFilled || !live?.getIsInitialized()) return;
      if (original) live.setOriginalTexture(original.texture);
      const held = live.committedSource().view;
      const moving = held.firstBlock !== next.firstBlock || held.lastBlock !== next.lastBlock;
      // A read the canvas no longer waits for still lands, and it claims a
      // slot when it does, so slots can go between the read that filled them
      // and this move. Composing one that went would draw silence over paint,
      // so the move waits for the next aim, which reads them again.
      if (!window.ready(moving ? next : held)) {
        this.releaseHeld();
        this.aimHeld();
        return;
      }
      const entering: number[] = [];
      if (moving) {
        // The slots take every block that leaves, so a block coming back
        // shows what the canvas last held of it, a commit's upload included.
        const leaving = window.blocksOf(held).filter((block) => block < next.firstBlock || block > next.lastBlock);
        window.copyBack(held, leaving, live.committedSource().texture, window.blocksOf(next));
        if (this.stroking) this.carryPaintOff(live, next);
        live.slideView(next, (target, blocks) => window.compose(next, blocks, target), { midStroke: this.stroking });
        window.markSlid(next, held);
        if (this.stroking) dropReturningPaint(this.carried, window, next, held);
        for (const block of window.blocksOf(next)) {
          if (block < held.firstBlock || block > held.lastBlock) entering.push(block);
        }
      }
      // Whatever the canvas still lacks: the blocks a slide did not bring in,
      // and the ones an abandoned fill left empty. Nothing painted is drawn
      // over, because a dab never lands on a block the canvas lacks.
      const view = live.committedSource().view;
      const lacking = window.canvasLacks(view);
      if (lacking.length > 0) {
        live.fillCanvas((target) => window.compose(view, lacking, target));
        window.markOnCanvas(lacking);
        entering.push(...lacking);
      }
      this.applyPendingPaint(live, view, entering);
      if (this.stroking) this.restoreReturningPaint(live, view);
      this.releaseHeld();
      this.aimHeld();
      this.deps.onChanged();
    });
    const tracked = filling.then(() => {
      if (this.fill === tracked) this.fill = null;
    });
    this.fill = tracked;
  }

  /**
   * Starts reading the blocks a window over [startFrame, endFrame) would need
   * into spare slots, so an aim there later composes without waiting on the
   * store. The canvas itself does not move.
   */
  prefetch(startFrame: number, endFrame: number): void {
    const window = this.blocks;
    const renderer = this.deps.renderer();
    if (!renderer?.getIsInitialized()) return;
    window.prefetch(window.plan(renderer.committedSource().view, startFrame, endFrame));
  }

  /**
   * Keeps a stroke's paint on the canvas after its pen-up until the function
   * returned is called: a block the window brings in meanwhile is read from a
   * store that does not hold the stroke yet, so its pixels of `values`, which
   * hold exactly the pixels of `ranges` in range order, go back on top.
   */
  holdPaint(ranges: Uint32Array, values: Promise<Float32Array>): () => void {
    // A display tile cut from the store while the stroke was painted lacks
    // its dabs; the canvas has them all now.
    this.recordDisplayEdit(ranges);
    this.deps.renderer()?.refreshDisplayFromStroke();
    const paint: PendingPaint = {
      ranges,
      values: null,
      landed: values.then(
        (landed) => {
          paint.values = landed;
        },
        () => {},
      ),
    };
    this.pending.push(paint);
    return () => {
      const at = this.pending.indexOf(paint);
      if (at >= 0) this.pending.splice(at, 1);
    };
  }

  /**
   * The left and right magnitudes at the taps `runs` names — [startPixel,
   * count, stride] per band — as the file stands: the store's values with
   * the paint of every stroke still committing over them. Null when the
   * store cannot serve them.
   */
  async readCommittedTaps(runs: Uint32Array): Promise<Float32Array | null> {
    const { readCurrentTaps, readCurrent } = this.deps;
    let taps: Float32Array | null;
    if (readCurrentTaps) {
      taps = await readCurrentTaps(runs);
    } else {
      const spans = tapSpanRanges(runs);
      const values = await readCurrent(spans);
      if (!values) return null;
      taps = new Float32Array(tapCount(runs) * 2);
      copyTapsFromCompact(taps, runs, values, spans);
    }
    if (!taps || this.pending.length === 0) return taps;
    await Promise.all(this.pending.map((paint) => paint.landed));
    for (const paint of this.pending) {
      if (paint.values) copyTapsFromCompact(taps, runs, paint.values, paint.ranges);
    }
    return taps;
  }

  /** Drops the slots of the blocks over the named file pixels, so the store serves them next. */
  forgetBlocks(ranges: Uint32Array): void {
    this.blocks.invalidate(blocksForPixelRanges(this.grid, ranges));
  }

  /** True when one window can hold [startFrame, endFrame). */
  fitsWindow(startFrame: number, endFrame: number): boolean {
    const window = this.blocks;
    const first = blockOfFrame(window.grid, startFrame);
    const last = blockOfFrame(window.grid, Math.max(startFrame, endFrame - 1));
    return last - first + 1 <= window.windowBlocks;
  }

  /** True while the canvas holds content for every block of its view. */
  isPopulated(): boolean {
    const view = this.view();
    if (!view) return false;
    return this.blocks.canvasLacks(view).length === 0;
  }

  /** True while an outstanding canvas fill will cover the screen's visible frames. */
  isFillingFrames(startFrame: number, endFrame: number): boolean {
    const window = this.blocks;
    const request = this.request;
    if (!request || !this.fitsWindow(startFrame, endFrame)) return false;
    return (
      blockOfFrame(window.grid, startFrame) >= request.view.firstBlock &&
      blockOfFrame(window.grid, Math.max(startFrame, endFrame - 1)) <= request.view.lastBlock
    );
  }

  /** True when the canvas holds the entire frame range and its original when requested. */
  holdsFrames(startFrame: number, endFrame: number, wantOriginal = false): boolean {
    const window = this.blocks;
    const view = this.view();
    if (!view || !this.fitsWindow(startFrame, endFrame)) return false;
    if (wantOriginal && !(this.original?.holds(view) ?? false)) return false;
    const first = blockOfFrame(window.grid, startFrame);
    const last = blockOfFrame(window.grid, Math.max(startFrame, endFrame - 1));
    if (first < view.firstBlock || last > view.lastBlock) return false;
    return window.canvasLacks({ firstBlock: first, lastBlock: last }).length === 0;
  }

  /**
   * Paints now when the canvas holds [startFrame, endFrame) and nothing is
   * already waiting; otherwise holds `paint` until the canvas takes the blocks.
   * Held paint runs in the order it was given, so a dab behind a waiting one
   * waits with it. Returns false when the range cannot fit or `paint` refuses.
   */
  paintWhenHeld(startFrame: number, endFrame: number, needs: DabNeeds, paint: () => boolean): boolean {
    if (!this.fitsWindow(startFrame, endFrame)) return false;
    if (this.held.length === 0 && this.holdsFrames(startFrame, endFrame, needs.original) && this.othersHold(needs)) {
      const painted = paint();
      if (this.displaySeed) this.recordDisplayEdit(this.dirtyPixelRanges());
      return painted;
    }
    this.held.push({ startFrame, endFrame, needs, paint });
    return true;
  }

  /**
   * Points a window at the frames a dab reads of another file, building it on
   * first use and re-reading it once that file's committed state moves.
   * Returns the textures to sample that file through, or null while the window
   * cannot serve the frames. Each file painted from gets a window of its own,
   * because every step names its own source.
   */
  aimSource(need: SourceNeed): SourceWindowTextures | null {
    return this.aimIn(this.sources, need);
  }

  /**
   * The same, for a file a convolve step takes its impulse response from. Each
   * such file gets a window of its own, because a step can paint from one file
   * and filter through another, and two steps can filter through two.
   */
  aimImpulse(need: SourceNeed): SourceWindowTextures | null {
    return this.aimIn(this.impulses, need);
  }

  /** Drops the windows over files the brush no longer paints from. */
  dropSourcesExcept(needs: readonly SourceNeed[]): void {
    dropExcept(this.sources, needs);
  }

  /** Drops the windows over response files the brush no longer filters through. */
  dropImpulsesExcept(needs: readonly SourceNeed[]): void {
    dropExcept(this.impulses, needs);
  }

  /** Drains held dabs, or reports why the incomplete stroke must be discarded. */
  async settle(signal?: AbortSignal): Promise<StrokeSettlement> {
    const epoch = this.strokeEpoch;
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const abort = () => {
      if (epoch === this.strokeEpoch) {
        this.held.length = 0;
        this.request = null;
      }
      cancel();
    };
    this.cancelSettlement = abort;
    signal?.addEventListener("abort", abort, { once: true });
    const stopped = () => signal?.aborted || this.disposed || epoch !== this.strokeEpoch;
    try {
      if (stopped()) return { status: "cancelled" };
      this.releaseHeld();
      for (let stalls = 0; this.held.length > 0 && stalls < HELD_PAINT_FILLS; ) {
        const before = this.held.length;
        const next = this.held[0];
        this.aim(next.startFrame, next.endFrame, next.needs.original);
        for (const need of next.needs.sources) this.aimSource(need);
        for (const need of next.needs.impulses) this.aimImpulse(need);
        const reads = [
          this.fill,
          ...[...this.sources.values()].map((slot) => slot.settled()),
          ...[...this.impulses.values()].map((slot) => slot.settled()),
        ].filter((read): read is Promise<void> => read !== null);
        if (reads.length === 0) break;
        await Promise.race([Promise.all(reads), cancelled]);
        if (stopped()) return { status: "cancelled" };
        this.releaseHeld();
        stalls = this.held.length < before ? 0 : stalls + 1;
      }
      if (this.held.length > 0) {
        this.held.length = 0;
        this.request = null;
        return { status: "failed", reason: "unavailable" };
      }
      await Promise.race([this.carried.settled(), cancelled]);
      return stopped() ? { status: "cancelled" } : { status: "completed" };
    } catch (error) {
      if (stopped()) return { status: "cancelled" };
      this.held.length = 0;
      this.request = null;
      diag.warn("gl", "stroke settlement failed", { error: String(error) });
      return { status: "failed", reason: "read-error" };
    } finally {
      if (this.cancelSettlement === abort) this.cancelSettlement = null;
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted && epoch === this.strokeEpoch) abort();
    }
  }

  /** The brush origin in the canvas's own UV. */
  dabCursor(cursorPos: Vector2): Vector2 {
    const view = this.view();
    if (!view) return cursorPos;
    return new Vector2(fileUvToViewUv(view, this.numFrames, cursorPos.x), cursorPos.y);
  }

  /**
   * The seconds a full window of the canvas holds, which is the whole file when
   * the canvas holds all of it. The window at the end of the file is shorter;
   * this is the span the canvas can hold wherever it sits.
   */
  windowSeconds(): number {
    const window = this.blocks;
    const { sampleRate } = this.deps.spectrogram;
    const blocks = Math.min(window.windowBlocks, window.grid.blockCount);
    const full = window.viewFor({ firstBlock: 0, lastBlock: blocks - 1 });
    return (full.endFrame - full.startFrame) / sampleRate;
  }

  /** The seconds the canvas's own UV spans. */
  dabDuration(totalDuration: number): number {
    const view = this.view();
    if (!view) return totalDuration;
    return (view.endFrame - view.startFrame) / this.deps.spectrogram.sampleRate;
  }

  beginStroke(): void {
    this.cancelSettlement?.();
    this.strokeEpoch++;
    this.stroking = true;
    // Paint the last stroke never landed belongs to that stroke, not this one.
    this.held.length = 0;
    // A fresh carry per stroke, so a commit still reading the last one keeps it.
    this.carried = new CarriedPaint();
    this.discardable = true;
    this.deps.renderer()?.beginStroke();
  }

  endStroke(): void {
    this.stroking = false;
    this.discardable = false;
    this.deps.renderer()?.endStroke();
    this.warmSlots();
  }

  /**
   * Takes back everything the stroke painted since `beginStroke`: the dabs
   * still waiting, the paint carried off the canvas, and the paint on it. The
   * store's values replace the stroke's footprint, with the paint of commits
   * still landing laid back on top. Resolves false when no stroke was begun.
   */
  async discardStroke(): Promise<boolean> {
    const renderer = this.deps.renderer();
    if (!renderer || !this.discardable) return false;
    this.cancelSettlement?.();
    this.strokeEpoch++;
    this.stroking = false;
    this.discardable = false;
    this.held.length = 0;
    this.request = null;
    const epoch = this.strokeEpoch;
    const ranges = this.dirtyPixelRanges();
    if (!ranges || ranges.length === 0) {
      renderer.clearDirtyRegion();
      return true;
    }
    const values = await this.deps.readCurrent(ranges);
    if (!values || epoch !== this.strokeEpoch || this.disposed) return false;
    const live = this.deps.renderer();
    if (!live?.getIsInitialized()) return false;
    // A stroke still committing is not in the store yet, so its paint goes
    // back over the store's values.
    await Promise.all(this.pending.map((paint) => paint.landed));
    if (epoch !== this.strokeEpoch || this.disposed) return false;
    this.patchFBODataCompact(values, ranges);
    for (const paint of this.pending) {
      if (!paint.values) continue;
      const within = intersectPixelRanges(paint.ranges, ranges);
      if (pixelRangeCount(within) === 0) continue;
      this.patchFBODataCompact(
        composePixelRangeValues(within, [{ ranges: paint.ranges, values: paint.values }]),
        within,
      );
    }
    this.carried = new CarriedPaint();
    live.clearDirtyRegion();
    return true;
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
    // Taken before the first await: a stroke starting now installs its own.
    const carried = this.carried;
    while (!carried.settledNow) await carried.settled();
    // The canvas read and the carry's snapshot are taken in one go, so no
    // slide can move pixels between the two while the read is on its way.
    const clipped = clipRangesToView(renderer.committedSource().view, this.layout(), pixelRanges);
    const reading = renderer.readPixelRanges(clipped.viewRanges);
    const carriedNow = clipped.covered ? null : carried.snapshot();
    const inView = await reading;
    if (!carriedNow) return inView;
    // What the canvas no longer holds was carried off it as the window slid.
    return composePixelRangeValues(pixelRanges, [carriedNow, { ranges: clipped.fileRanges, values: inView }]);
  }

  /** The stroke's committed footprint as file pixel ranges, carry included. */
  dirtyPixelRanges(): Uint32Array | null {
    const renderer = this.deps.renderer();
    const ranges = renderer?.getDirtyPixelRanges() ?? null;
    if (!renderer) return ranges;
    const inView = ranges ? viewRangesToFile(renderer.committedSource().view, ranges) : null;
    const carried = this.carried.ranges();
    if (carried.length === 0) return inView;
    return inView ? mergePixelRanges(inView, carried) : carried;
  }

  /** The stroke's committed footprint in the file's UV, carry included. */
  committedFootprintUv(): PaintBox | null {
    const renderer = this.deps.renderer();
    const footprint = renderer?.getCommittedFootprintUv() ?? null;
    if (!renderer) return footprint;
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
    if (!region || !view) return region;
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
    if (!view) {
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
    this.cancelSettlement?.();
    this.strokeEpoch++;
    this.held.length = 0;
    this.request = null;
    this.stroking = false;
    this.discardable = false;
    this.carried = new CarriedPaint();
    if (this.displaySeed) this.recordDisplayEdit(this.fullFilePixelRanges());
    const view = renderer.committedSource().view;
    renderer.setFBOData(composeViewContent(view, data));
    renderer.seedDisplayFromPacked(data);
    renderer.getDisplayTiles()?.dropTiles(this.fullFilePixelRanges());
    const window = this.blocks;
    window.invalidate();
    // The whole view was written, so the canvas lacks none of it.
    window.markOnCanvas(window.blocksOf(view));
    return true;
  }

  /** Puts the named file pixels of `data` on the canvas. */
  patchFBOData(data: Float32Array, pixelRanges: Uint32Array): boolean {
    const renderer = this.deps.renderer();
    if (!renderer) return false;
    this.recordDisplayEdit(pixelRanges);
    const clipped = clipRangesToView(renderer.committedSource().view, this.layout(), pixelRanges);
    renderer.patchFBODataCompact(gatherPixelRanges(data, clipped.fileRanges), clipped.viewRanges);
    this.patchOutside(renderer, gatherPixelRanges(data, pixelRanges), pixelRanges);
    return true;
  }

  /** Puts compact values for the named file pixels on the canvas. */
  patchFBODataCompact(values: Float32Array, pixelRanges: Uint32Array): boolean {
    const renderer = this.deps.renderer();
    if (!renderer) return false;
    this.recordDisplayEdit(pixelRanges);
    const clipped = clipRangesToView(renderer.committedSource().view, this.layout(), pixelRanges, values);
    if (clipped.viewValues) renderer.patchFBODataCompact(clipped.viewValues, clipped.viewRanges);
    this.patchOutside(renderer, values, pixelRanges);
    return true;
  }

  /** Turns phase over the named file pixels. */
  applyPhaseTurns(turns: ArrayLike<number>): boolean {
    const renderer = this.deps.renderer();
    if (!renderer) return false;
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
    const turned: number[] = [];
    for (let i = 0; i + 3 < turns.length; i += 4) turned.push(turns[i], turns[i + 1]);
    this.blocks.invalidate(blocksForPixelRanges(this.grid, Uint32Array.from(turned)));
    this.carried = new CarriedPaint();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelSettlement?.();
    this.strokeEpoch++;
    this.generation++;
    this.displaySeed = null;
    this.blocks.dispose();
    this.original?.dispose();
    for (const slot of this.sources.values()) slot.dispose();
    this.sources.clear();
    for (const slot of this.impulses.values()) slot.dispose();
    this.impulses.clear();
    this.request = null;
    this.held.length = 0;
  }

  // ---------- inside ----------

  private recordDisplayEdit(ranges: Uint32Array | null): void {
    if (this.displaySeed && ranges) this.displaySeed.edited = mergePixelRanges(this.displaySeed.edited, ranges);
  }

  private view(): CanvasView | null {
    return this.deps.renderer()?.committedSource().view ?? null;
  }

  /** Points the canvas at the held paint still waiting, so the next read serves it. */
  private aimHeld(): void {
    if (!this.stroking || this.held.length === 0) return;
    const next = this.held[0];
    this.aim(next.startFrame, next.endFrame, next.needs.original);
  }

  /**
   * The frames of the oldest held dab, widened over the dabs behind it while
   * one window still holds them all, so one read serves a run of them, and
   * whether any of those dabs reads the original.
   */
  private heldSpan(): { startFrame: number; endFrame: number; original: boolean } {
    let startFrame = this.held[0].startFrame;
    let endFrame = this.held[0].endFrame;
    let original = this.held[0].needs.original;
    for (let i = 1; i < this.held.length; i++) {
      const start = Math.min(startFrame, this.held[i].startFrame);
      const end = Math.max(endFrame, this.held[i].endFrame);
      if (!this.fitsWindow(start, end)) break;
      startFrame = start;
      endFrame = end;
      original = original || this.held[i].needs.original;
    }
    return { startFrame, endFrame, original };
  }

  /** Runs the held paint the canvas can now take, oldest first. */
  private releaseHeld(): void {
    while (this.held.length > 0) {
      const next = this.held[0];
      if (!this.holdsFrames(next.startFrame, next.endFrame, next.needs.original) || !this.othersHold(next.needs)) {
        return;
      }
      this.held.shift();
      next.paint();
      if (this.displaySeed) this.recordDisplayEdit(this.dirtyPixelRanges());
    }
  }

  /** The window over the file's original, built the first time a dab asks to read it. */
  private originalWindow(): PackedWindow {
    if (!this.original) {
      this.original = new PackedWindow(this.deps.gl, this.grid, {
        windowBlocks: this.windowBlocks,
        read: this.deps.readRoot,
        readBlock: this.deps.readRootBlock,
      });
    }
    return this.original;
  }

  /** True while every other-file window holds what the dab asked of it. */
  private othersHold(needs: DabNeeds): boolean {
    if (!needs.sources.every((need) => this.sources.get(need.fileId)?.holds(need) ?? false)) return false;
    return needs.impulses.every((need) => this.impulses.get(need.fileId)?.holds(need) ?? false);
  }

  /** The slot in `slots` for the need's file, building one on first use. */
  private aimIn(slots: Map<string, SourceWindowSlot>, need: SourceNeed): SourceWindowTextures | null {
    const blocks = this.deps.sourceBlocks(need.fileId);
    if (!blocks) return null;
    let slot = slots.get(need.fileId);
    if (!slot) {
      slot = new SourceWindowSlot(this.deps.gl, this.windowBlocks);
      slots.set(need.fileId, slot);
    }
    return slot.aim(need, blocks);
  }

  private expectRenderer(): StrokeRenderer {
    const renderer = this.deps.renderer();
    if (!renderer) throw new Error("StrokeRenderer not initialized");
    return renderer;
  }

  private layout(): BandLayout {
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
    this.blocks.invalidate(blocksForPixelRanges(this.grid, fileRanges));
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
  /**
   * Puts the paint of strokes still committing back on the blocks that just
   * entered the canvas, oldest stroke first. A block whose slot holds paint
   * the canvas gave it came back with that paint and is left alone.
   */
  private applyPendingPaint(renderer: StrokeRenderer, view: CanvasView, entering: number[]): void {
    const window = this.blocks;
    if (this.pending.length === 0) return;
    let target: Uint32Array = new Uint32Array(0);
    for (const block of entering) {
      if (window.holdsPaint(block)) continue;
      const list = blockPixelRanges(window.grid, block);
      target = mergePixelRanges(target, list.ranges.subarray(0, list.count * 2));
    }
    if (target.length === 0) return;
    for (const paint of this.pending) {
      if (!paint.values) continue;
      const within = intersectPixelRanges(paint.ranges, target);
      if (pixelRangeCount(within) === 0) continue;
      const viewRanges = fileRangesToView(view, this.layout(), within);
      if (!viewRanges) continue;
      const values = composePixelRangeValues(within, [{ ranges: paint.ranges, values: paint.values }]);
      renderer.patchFBODataCompact(values, viewRanges);
    }
  }

  /**
   * Puts the carried paint of the view's blocks back on the canvas. A block
   * whose slot lost its paint to the store came back composed from the
   * store's values, and the carry is the only place the stroke's paint on it
   * survives: the canvas takes it, so the stroke shows it and paints over it,
   * and the carry lets it go, so the commit reads the canvas there.
   */
  private restoreReturningPaint(renderer: StrokeRenderer, view: CanvasView): void {
    if (this.carried.size === 0) return;
    const { ranges, values } = this.carried.take(mergePixelRanges(view.ranges, new Uint32Array(0)));
    if (pixelRangeCount(ranges) === 0) return;
    const viewRanges = fileRangesToView(view, this.layout(), ranges);
    if (!viewRanges) return;
    renderer.patchFBODataCompact(values, viewRanges);
  }

  private carryPaintOff(renderer: StrokeRenderer, next: CanvasView): void {
    const window = this.blocks;
    const carried = carryPaintOut(renderer, window, this.carried, next, this.numFrames);
    if (!carried) return;
    const revision = this.strokeEpoch;
    void carried.read.then((values) => {
      if (this.disposed || revision !== this.strokeEpoch || this.deps.renderer() !== renderer) return;
      renderer.patchDisplayFromCompact(values, carried.fileRanges);
      renderer.getDisplayTiles()?.dropTiles(carried.fileRanges);
      this.deps.onChanged();
    });
  }
}
