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
import {
  canvasExtraSlotBlocks,
  canvasPaintExtraSlotBlocks,
  canvasWindowBlocks,
  CANVAS_WINDOW_SPARE_BLOCKS,
} from "./gpu-budget";
import { CarriedPaint, type PaintBox } from "./carried-paint";
import type { CoarseStrip } from "./coarse-strip";
import { diag } from "./diag-log";
import { yieldIfLong } from "./frame-yield";
import {
  blockReadSpan,
  blocksOfDab,
  blockWriteSpan,
  HeldDabs,
  type DabExtent,
  type DabPainter,
  type FrameSpan,
} from "./held-dabs";
import { PackedWindow } from "./packed-window";
import {
  composePixelRangeValues,
  copyCompactOverlap,
  copyTapsFromCompact,
  gatherPixelRanges,
  intersectPixelRanges,
  mergePixelRanges,
  pixelRangeCount,
  subtractPixelRanges,
  tapCount,
  tapSpanRanges,
} from "./pixel-ranges";
import {
  sourceNeedsOver,
  SourceWindowSlot,
  type SourceFileBlocks,
  type SourceNeed,
  type SourceRead,
  type SourceWindowTextures,
} from "./source-window";
import type { StrokeRenderer } from "./stroke-renderer";
import { paintOnBlock, StrokeSlots } from "./stroke-slots";

// Block reads kept in flight ahead of the block being drawn into the display.
const DISPLAY_DRAW_READ_AHEAD = 4;

/** A rectangle of the file in unpacked UV, as the dirty region is kept. */
export type UvRegion = { startX: number; endX: number; startY: number; endY: number };

export type { SourceNeed } from "./source-window";

/**
 * What a dab reads beyond the canvas: other files, each through a window
 * this canvas owns, and this file's original state.
 */
export type DabNeeds = { sources: readonly SourceRead[]; impulses: readonly SourceNeed[]; original: boolean };

/** A window the canvas is reading towards, and whether the original reads alongside. */
type WindowRequest = { view: CanvasView; original: boolean };

/**
 * Values the block slots do not hold yet, by file range, laid over every
 * block the canvas brings in until they do: a stroke's paint while its commit
 * stores it, or values a commit stored while a later stroke was on the
 * canvas. `shown`, when set, narrows the pixels the layer still speaks for.
 */
type PendingPaint = {
  ranges: Uint32Array;
  values: Float32Array | null;
  landed: Promise<void>;
  shown: Uint32Array | null;
};

/** Pixels the pen-up read copies between two checks for a frame. */
const READ_PIECE_PIXELS = 1 << 16;

/** Work the slot refresh after a commit does before it lets a frame through. */
const SLOT_REFRESH_BUDGET_MS = 4;

export type StrokeSettlement =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; reason: "unavailable" | "read-error" };

/**
 * Bytes the canvas window's slots may hold: the window, the spares, and the
 * slots the budget has left. A window spanning the whole file never slides,
 * so it keeps the window alone.
 */
function canvasWindowSlotBytes(grid: BlockGrid, windowBlocks: number): number {
  const slots =
    windowBlocks >= grid.blockCount
      ? windowBlocks
      : windowBlocks + CANVAS_WINDOW_SPARE_BLOCKS + canvasExtraSlotBlocks(grid, windowBlocks);
  return slots * blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL;
}

/** Longest idle wait between two blocks the slot warm-up reads. */
const SLOT_WARM_STEP_MS = 50;
/** Blocks the slot warm-up reads at once. */
const SLOT_WARM_READS = 3;
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
  readonly grid: BlockGrid;
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
  private readonly held: HeldDabs<DabNeeds>;
  private carried = new CarriedPaint();
  private strokeSlots: StrokeSlots | null = null;
  private readonly pending: PendingPaint[] = [];
  private slotWrites: Promise<void> = Promise.resolve();
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
    this.held = new HeldDabs(grid);
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
      const near = Math.round((view.firstBlock + view.lastBlock) / 2);
      const reads = Array.from({ length: SLOT_WARM_READS }, () => window.warmOne(near));
      Promise.all(reads).then(
        (taken) => {
          const took = taken.filter(Boolean).length;
          if (took > 0) {
            warmed += took;
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
    const waiting = this.stroking ? this.held.target((start, end) => this.fitsWindow(start, end)) : null;
    if (waiting) {
      startFrame = waiting.span.start;
      endFrame = waiting.span.end;
      wantOriginal = wantOriginal || waiting.payloads.some((needs) => needs.original);
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
        if (this.stroking) this.carryPaintOff(live, next);
        live.slideView(next, (target, blocks) => window.compose(next, blocks, target), { midStroke: this.stroking });
        window.markSlid(next, held);
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
      if (this.stroking) this.restoreReturningPaint(live, view, entering);
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
   * hold exactly the pixels of `ranges` in range order, go back on top. Call
   * it with `stored` once the store holds the stroke, and the block slots take
   * the paint before it lets go, so they keep mirroring the store; `except`
   * names pixels the commit stored values of its own for, which the slots
   * have already taken. The call resolves once the paint is let go.
   */
  holdPaint(
    ranges: Uint32Array,
    values: Promise<Float32Array>,
  ): (stored: boolean, except?: Uint32Array | null) => Promise<void> {
    // A display tile cut from the store while the stroke was painted lacks
    // its dabs: tiles over the canvas take them from it, the rest are cut
    // again once the paint is held.
    this.recordDisplayEdit(ranges);
    const renderer = this.deps.renderer();
    renderer?.getDisplayTiles()?.dropTiles(ranges);
    renderer?.refreshDisplayFromStroke();
    const aheadStart = performance.now();
    const ahead = renderer ? this.takePaintAhead(renderer, ranges) : [];
    diag.timing("timing", "stroke taken ahead", performance.now() - aheadStart, { blocks: ahead.length });
    const paint: PendingPaint = {
      ranges,
      values: null,
      landed: values.then(
        (landed) => {
          paint.values = landed;
        },
        () => {},
      ),
      shown: null,
    };
    this.pending.push(paint);
    const letGo = (): void => {
      const at = this.pending.indexOf(paint);
      if (at >= 0) this.pending.splice(at, 1);
    };
    return async (stored, except) => {
      if (!this.pending.includes(paint)) return;
      if (!stored || !paint.values || this.disposed) {
        // Slots that took the paint ahead of a store that never got it read
        // the store again.
        if (!stored && !this.disposed) this.blocks.invalidate(ahead.filter((block) => this.blocks.isAhead(block)));
        letGo();
        return;
      }
      const ranges = except ? subtractPixelRanges(paint.ranges, except) : paint.ranges;
      paint.shown = ranges;
      await this.writeSlots(ranges, paint.ranges, paint.values).finally(letGo);
    };
  }

  /**
   * Puts a stroke's blocks into the block slots at its pen-up, ahead of its
   * commit, so a block the window brings in while the commit stores it needs
   * nothing laid over it: the blocks on the canvas are copied from it, those
   * the stroke slots hold from there. A block the stroke left in RAM loses
   * its slot, so it is read from the store and the paint laid over it.
   * Returns the blocks taken.
   */
  private takePaintAhead(renderer: StrokeRenderer, ranges: Uint32Array): number[] {
    const window = this.blocks;
    const { view, texture } = renderer.committedSource();
    const painted = blocksForPixelRanges(this.grid, ranges);
    const lacking = new Set(window.canvasLacks(view));
    const onCanvas = painted.filter(
      (block) => block >= view.firstBlock && block <= view.lastBlock && !lacking.has(block),
    );
    const held = this.strokeSlots?.heldAmong(painted) ?? [];
    const taken = new Set([...onCanvas, ...held]);
    window.invalidate(painted.filter((block) => !taken.has(block) && window.hasSlot(block)));
    window.takeAhead(view, onCanvas, texture);
    if (this.strokeSlots) window.copyAhead(this.strokeSlots.paintCache, held);
    return [...taken];
  }

  /**
   * Writes values the store now holds into the slots of the blocks they fall
   * in: `ranges` of the values laid out in `valueRanges` order. A slot taken
   * ahead of the store already holds them, or newer, and is left alone.
   * Writes run one after another in the order the store took them, a block
   * at a time with frames between, so an older write never lands over a
   * newer one and no single upload stalls a frame.
   */
  private writeSlots(ranges: Uint32Array, valueRanges: Uint32Array, values: Float32Array): Promise<void> {
    const window = this.blocks;
    window.storeMoved();
    const write = async (): Promise<void> => {
      let since = performance.now();
      for (const block of blocksForPixelRanges(this.grid, ranges)) {
        if (this.disposed) return;
        if (!window.hasSlot(block) || window.isAhead(block)) continue;
        const list = blockPixelRanges(this.grid, block);
        const within = intersectPixelRanges(ranges, list.ranges.subarray(0, list.count * 2));
        if (pixelRangeCount(within) === 0) continue;
        window.patch(within, composePixelRangeValues(within, [{ ranges: valueRanges, values }]));
        since = await yieldIfLong(since, SLOT_REFRESH_BUDGET_MS);
      }
    };
    const written = this.slotWrites.then(write);
    this.slotWrites = written.catch(() => undefined);
    return written;
  }

  /** The pixels a pending layer still speaks for, and their values in the order of those ranges. */
  private pendingLayer(paint: PendingPaint): { ranges: Uint32Array; values: Float32Array } | null {
    if (!paint.values) return null;
    if (!paint.shown) return { ranges: paint.ranges, values: paint.values };
    const ranges = paint.shown;
    return { ranges, values: composePixelRangeValues(ranges, [{ ranges: paint.ranges, values: paint.values }]) };
  }

  /**
   * Takes a commit that landed while a later stroke was already on the
   * canvas: the store now holds `values` over the file pixels `ranges`. The
   * stroke-start snapshot takes them at once, and the block slots over them
   * are read again. The canvas and the picture take them except where a
   * stroke not yet stored has painted, because that paint is what those
   * pixels will hold.
   */
  landUnderStroke(ranges: Uint32Array, values: Float32Array): void {
    const renderer = this.deps.renderer();
    if (!renderer || this.disposed) return;
    // The slots over them read the store again, with the paint of strokes
    // still committing laid over it.
    this.blocks.invalidate(blocksForPixelRanges(this.grid, ranges));
    let unstored: Uint32Array = new Uint32Array(0);
    for (const paint of this.pending) unstored = mergePixelRanges(unstored, paint.ranges);
    const base = unstored.length > 0 ? subtractPixelRanges(ranges, unstored) : ranges;
    const view = renderer.committedSource().view;
    const layout = this.layout();
    const inView = (fileRanges: Uint32Array): { fileRanges: Uint32Array; viewRanges: Uint32Array } | null => {
      const clipped = clipRangesToView(view, layout, fileRanges);
      return clipped.viewRanges.length > 0 ? clipped : null;
    };
    const cut = (fileRanges: Uint32Array): Float32Array => composePixelRangeValues(fileRanges, [{ ranges, values }]);
    const start = inView(base);
    if (start) renderer.patchStrokeStartCompact(cut(start.fileRanges), start.viewRanges);
    const painted = this.dirtyPixelRanges();
    const shown = painted ? subtractPixelRanges(base, painted) : base;
    if (pixelRangeCount(shown) === 0) return;
    const onCanvas = inView(shown);
    if (onCanvas) renderer.patchCanvasCompact(cut(onCanvas.fileRanges), onCanvas.viewRanges);
    this.recordDisplayEdit(shown);
    renderer.patchDisplayFromCompact(cut(shown), shown);
    renderer.getDisplayTiles()?.dropTiles(shown);
    this.deps.onChanged();
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
      const layer = this.pendingLayer(paint);
      if (layer) copyTapsFromCompact(taps, runs, layer.values, layer.ranges);
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
   * True when the canvas can paint every block of the dab: each block, with
   * what the dab reads either side of it, fits one window.
   */
  servable(extent: DabExtent): boolean {
    return blocksOfDab(this.grid, extent).every((block) => {
      const read = blockReadSpan(this.grid, extent, block);
      return this.fitsWindow(read.start, read.end);
    });
  }

  /**
   * Paints the dab now when nothing is waiting and the canvas holds all it
   * reads; otherwise holds it and paints it a run of blocks at a time as the
   * canvas takes them, each block after the dabs before it that paint there.
   * Returns false when the canvas can never serve it or `paint` refuses.
   */
  paintWhenHeld(extent: DabExtent, needs: DabNeeds, paint: DabPainter): boolean {
    if (!this.servable(extent)) return false;
    if (this.held.size === 0 && extent.writes.length === 1 && this.othersHold(needs, null)) {
      const write = extent.writes[0];
      const read = { start: Math.max(0, write.start - extent.before), end: write.end + extent.after };
      if (this.fitsWindow(read.start, read.end) && this.holdsFrames(read.start, read.end, needs.original)) {
        const painted = paint(null);
        if (this.displaySeed) this.recordDisplayEdit(this.dirtyPixelRanges());
        return painted;
      }
    }
    this.held.push(extent, needs, paint, needs.sources.length > 0);
    this.releaseHeld();
    return true;
  }

  /** A span of file frames in the canvas's own frames, clamped to what it holds; null stays null. */
  clipToCanvas(clip: FrameSpan | null): { frameStart: number; frameEnd: number } | null {
    const view = this.view();
    if (!clip || !view) return null;
    const frames = view.endFrame - view.startFrame;
    return {
      frameStart: Math.max(0, clip.start - view.startFrame),
      frameEnd: Math.min(frames, clip.end - view.startFrame),
    };
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
        this.held.clear();
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
      for (let stalls = 0; this.held.size > 0 && stalls < HELD_PAINT_FILLS; ) {
        const before = this.held.pieces;
        const next = this.held.target((start, end) => this.fitsWindow(start, end));
        if (!next) break;
        this.aim(
          next.span.start,
          next.span.end,
          next.payloads.some((needs) => needs.original),
        );
        const [oldest] = next.payloads;
        for (const need of sourceNeedsOver(oldest.sources, next.part)) this.aimSource(need);
        for (const need of oldest.impulses) this.aimImpulse(need);
        const reads = [
          this.fill,
          ...[...this.sources.values()].map((slot) => slot.settled()),
          ...[...this.impulses.values()].map((slot) => slot.settled()),
        ].filter((read): read is Promise<void> => read !== null);
        if (reads.length === 0) break;
        await Promise.race([Promise.all(reads), cancelled]);
        if (stopped()) return { status: "cancelled" };
        this.releaseHeld();
        stalls = this.held.pieces < before ? 0 : stalls + 1;
      }
      if (this.held.size > 0) {
        this.held.clear();
        this.request = null;
        return { status: "failed", reason: "unavailable" };
      }
      await Promise.race([this.carried.settled(), cancelled]);
      return stopped() ? { status: "cancelled" } : { status: "completed" };
    } catch (error) {
      if (stopped()) return { status: "cancelled" };
      this.held.clear();
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
    this.held.clear();
    // A fresh carry per stroke, so a commit still reading the last one keeps it.
    this.resetCarry();
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
    this.held.clear();
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
      const layer = this.pendingLayer(paint);
      if (!layer) continue;
      const within = intersectPixelRanges(layer.ranges, ranges);
      if (pixelRangeCount(within) === 0) continue;
      this.patchFBODataCompact(composePixelRangeValues(within, [layer]), within);
    }
    this.resetCarry();
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

  /**
   * The named file pixels, taken from the canvas and from what the stroke
   * left off it. Read once a stroke has ended: the carry is copied when the
   * canvas read lands, and only an ended stroke's carry no longer moves.
   */
  async readPixelRanges(pixelRanges: Uint32Array): Promise<Float32Array> {
    const renderer = this.expectRenderer();
    // Taken, and the GPU copies issued, before the first await: a stroke
    // starting now installs its own carry and reuses the slots.
    const carried = this.carried;
    const clipped = clipRangesToView(renderer.committedSource().view, this.layout(), pixelRanges);
    const inViewRead = renderer.readPixelRanges(clipped.viewRanges);
    const slotted = this.strokeSlots?.within(pixelRanges) ?? new Uint32Array(0);
    const slotRead = slotted.length > 0 && this.strokeSlots ? this.strokeSlots.read(slotted) : null;
    while (!carried.settledNow) await carried.settled();
    const inView = await inViewRead;
    if (clipped.covered) return inView;
    const slotValues = slotRead ? await slotRead : null;
    // What the canvas no longer holds was kept in the stroke slots or carried
    // into RAM as the window slid; a block is in one of the three at a time.
    // A piece at a time, so a stroke over most of the file leaves room for frames.
    const out = new Float32Array(pixelRangeCount(pixelRanges) * 4);
    const piece = new Uint32Array(2);
    let since = performance.now();
    let at = 0;
    for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
      const end = pixelRanges[i] + pixelRanges[i + 1];
      for (let start = pixelRanges[i]; start < end; start += READ_PIECE_PIXELS) {
        piece[0] = start;
        piece[1] = Math.min(READ_PIECE_PIXELS, end - start);
        const part = out.subarray(at, at + piece[1] * 4);
        copyCompactOverlap(part, piece, inView, clipped.fileRanges);
        if (slotValues) copyCompactOverlap(part, piece, slotValues, slotted);
        carried.copyInto(part, piece);
        at += piece[1] * 4;
        since = await yieldIfLong(since);
      }
    }
    return out;
  }

  /** The stroke's committed footprint as file pixel ranges, what left the canvas included. */
  dirtyPixelRanges(): Uint32Array | null {
    const renderer = this.deps.renderer();
    const ranges = renderer?.getDirtyPixelRanges() ?? null;
    if (!renderer) return ranges;
    let all = ranges ? viewRangesToFile(renderer.committedSource().view, ranges) : null;
    for (const off of [this.carried.ranges(), this.strokeSlots?.ranges()]) {
      if (off && off.length > 0) all = all ? mergePixelRanges(all, off) : off;
    }
    return all;
  }

  /** The stroke's committed footprint in the file's UV, what left the canvas included. */
  committedFootprintUv(): PaintBox | null {
    const renderer = this.deps.renderer();
    const footprint = renderer?.getCommittedFootprintUv() ?? null;
    if (!renderer) return footprint;
    let box = footprint && { ...footprint, ...this.boxToFileUv(footprint) };
    for (const off of [this.carried.paintBox(), this.strokeSlots?.paintBox()]) {
      if (!off) continue;
      box = box
        ? {
            timeMin: Math.min(box.timeMin, off.timeMin),
            timeMax: Math.max(box.timeMax, off.timeMax),
            pitchMin: Math.min(box.pitchMin, off.pitchMin),
            pitchMax: Math.max(box.pitchMax, off.pitchMax),
          }
        : off;
    }
    return box;
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
    this.held.clear();
    this.request = null;
    this.stroking = false;
    this.discardable = false;
    this.resetCarry();
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
    this.resetCarry();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelSettlement?.();
    this.strokeEpoch++;
    this.generation++;
    this.displaySeed = null;
    this.blocks.dispose();
    this.strokeSlots?.dispose();
    this.original?.dispose();
    for (const slot of this.sources.values()) slot.dispose();
    this.sources.clear();
    for (const slot of this.impulses.values()) slot.dispose();
    this.impulses.clear();
    this.request = null;
    this.held.clear();
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
    if (!this.stroking) return;
    const next = this.held.target((start, end) => this.fitsWindow(start, end));
    if (next)
      this.aim(
        next.span.start,
        next.span.end,
        next.payloads.some((needs) => needs.original),
      );
  }

  /** Paints the held blocks the canvas can now take. */
  private releaseHeld(): void {
    if (this.held.size === 0) return;
    this.held.release((extent, needs, block) => {
      const read = blockReadSpan(this.grid, extent, block);
      return (
        this.holdsFrames(read.start, read.end, needs.original) &&
        this.othersHold(needs, blockWriteSpan(this.grid, extent, block))
      );
    });
    if (this.displaySeed) this.recordDisplayEdit(this.dirtyPixelRanges());
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

  /** True while every other-file window holds what the dab reads while it writes `part`, or all of it for null. */
  private othersHold(needs: DabNeeds, part: FrameSpan | null): boolean {
    const sources = sourceNeedsOver(needs.sources, part);
    if (!sources.every((need) => this.sources.get(need.fileId)?.holds(need) ?? false)) return false;
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
    this.resetCarry();
  }

  /**
   * Puts the paint of strokes still committing back on the blocks that just
   * entered the canvas from slots that mirror the store, oldest stroke first;
   * a slot taken ahead of the store holds it already. The stroke-start
   * snapshot takes them too, since a stroke blends from what the file holds
   * before it.
   */
  private applyPendingPaint(renderer: StrokeRenderer, view: CanvasView, entering: number[]): void {
    const window = this.blocks;
    if (this.pending.length === 0 || entering.length === 0) return;
    let target: Uint32Array = new Uint32Array(0);
    for (const block of entering) {
      if (window.isAhead(block)) continue;
      const list = blockPixelRanges(window.grid, block);
      target = mergePixelRanges(target, list.ranges.subarray(0, list.count * 2));
    }
    if (target.length === 0) return;
    for (const paint of this.pending) {
      const layer = this.pendingLayer(paint);
      if (!layer) continue;
      const within = intersectPixelRanges(layer.ranges, target);
      if (pixelRangeCount(within) === 0) continue;
      const viewRanges = fileRangesToView(view, this.layout(), within);
      if (!viewRanges) continue;
      renderer.patchFBODataCompact(composePixelRangeValues(within, [layer]), viewRanges);
    }
  }

  /**
   * Puts the stroke's paint back on the blocks that just entered the canvas,
   * with the stroke masks it left with: from the stroke slots, or from RAM
   * for a block the slots let go. The stroke-start snapshot keeps the block
   * slots' values, so the stroke goes on blending from what the file held
   * before it, and the masks keep a weaker dab from pulling back what a
   * stronger one painted. The paint leaves the slots and the carry, so the
   * commit reads it off the canvas.
   */
  private restoreReturningPaint(renderer: StrokeRenderer, view: CanvasView, entering: number[]): void {
    if (entering.length === 0) return;
    const layout = this.layout();
    this.strokeSlots?.restore(
      view,
      entering,
      (ranges, draw) => renderer.drawCanvas(fileRangesToView(view, layout, ranges) ?? new Uint32Array(0), draw),
      (step, draw) => renderer.drawStrokeMask(step, draw),
    );
    if (this.carried.size === 0) return;
    let target: Uint32Array = new Uint32Array(0);
    for (const block of entering) {
      const list = blockPixelRanges(this.blocks.grid, block);
      target = mergePixelRanges(target, list.ranges.subarray(0, list.count * 2));
    }
    const { ranges, values, masks } = this.carried.take(target);
    if (pixelRangeCount(ranges) === 0) return;
    const viewRanges = fileRangesToView(view, layout, ranges);
    if (!viewRanges) return;
    renderer.patchCanvasCompact(values, viewRanges);
    renderer.patchStrokeMasks(viewRanges, masks);
  }

  /**
   * Keeps what the stroke painted on the blocks about to leave the canvas for
   * `next` in the stroke slots, with the masks over it. When the slots are
   * full, the blocks held longest go to RAM to make room.
   */
  private carryPaintOff(renderer: StrokeRenderer, next: CanvasView): void {
    const dirty = renderer.getDirtyPixelRanges();
    if (!dirty) return;
    const { view: current, texture } = renderer.committedSource();
    const painted = viewRangesToFile(current, dirty);
    const entries: { block: number; ranges: Uint32Array }[] = [];
    for (let block = current.firstBlock; block <= current.lastBlock; block++) {
      if (block >= next.firstBlock && block <= next.lastBlock) continue;
      const ranges = paintOnBlock(this.grid, block, painted);
      if (ranges.length > 0) entries.push({ block, ranges });
    }
    if (entries.length === 0) return;
    const slots = this.slotsForStroke();
    const box = slots.paintBox();
    for (const block of slots.oldest(entries.length)) {
      const { ranges, read } = slots.letGo(block);
      this.carried.carry(ranges, read);
      if (box) this.carried.addBox(box);
    }
    slots.keep(current, entries, texture, renderer.strokeMaskTextures());
    const footprint = renderer.getCommittedFootprintUv();
    if (footprint) slots.addBox({ ...footprint, ...this.boxToFileUv(footprint) });
  }

  /** The stroke slots, made on first use and sized by the budget. */
  private slotsForStroke(): StrokeSlots {
    if (!this.strokeSlots) {
      const blocks =
        this.windowBlocks + CANVAS_WINDOW_SPARE_BLOCKS + canvasPaintExtraSlotBlocks(this.grid, this.windowBlocks);
      this.strokeSlots = new StrokeSlots(this.deps.gl, this.grid, blocks);
    }
    return this.strokeSlots;
  }

  /** Forgets the paint that left the canvas: the state it spoke for moved, or a new stroke began. */
  private resetCarry(): void {
    this.carried = new CarriedPaint();
    this.strokeSlots?.clear();
  }
}
