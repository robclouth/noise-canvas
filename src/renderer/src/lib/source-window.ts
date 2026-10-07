import { type DataTexture, type Texture, type WebGLRenderer, type WebGLRenderTarget } from "three";
import type { SpectrogramData } from "../store/types";
import { blockGrid, blockOfFrame, type BlockGrid } from "./block-grid";
import type { CanvasView } from "./canvas-view";
import { needsCanvasWindow, type BlockReader, type BlockValueReader } from "./canvas-window";
import { canvasWindowBlocks } from "./gpu-budget";
import { diag } from "./diag-log";
import { PackedWindow } from "./packed-window";
import { bandMetadataTexture } from "./band-metadata-texture";
import type { SelfState } from "./self-window";

/** What a source window needs to read another file's blocks. */
export type SourceFileBlocks = {
  spectrogram: SpectrogramData;
  /** The file's committed pixels, by file-absolute range. */
  readCurrent: BlockValueReader;
  /** The file's original pixels — what its block store was seeded with. */
  readRoot: BlockValueReader;
  /** The committed pixels of one block, without the range read's copy. */
  readCurrentBlock?: BlockReader;
  /** The original pixels of one block, without the range read's copy. */
  readRootBlock?: BlockReader;
  /** Changes whenever the file's committed state moves, so a window re-reads. */
  revision: () => number;
};

/**
 * The file and frames a dab reads through a window the destination owns.
 * `self` marks a read of the painted file itself.
 */
export type SourceNeed = {
  fileId: string;
  startFrame: number;
  endFrame: number;
  wantOriginal: boolean;
  self?: boolean;
};

/** The textures a brush samples a source window through. */
export type SourceWindowTextures = {
  packed: WebGLRenderTarget;
  metadata: DataTexture;
  /** The span the textures lay out. */
  view: CanvasView;
  /** Present once a step that reads the original has asked for it. */
  original?: Texture;
};

/**
 * The frames a source window should hold to serve a dab that reads
 * [start, end) of the file. The read wraps into the file — the shaders wrap a
 * source UV — and is then widened either side by `pad`, what the dab's
 * effects read around it, or by its own length when that is not known. A read
 * that wraps across the file's end spans both of its edges and no one window
 * holds both; this keeps the end it starts at.
 */
export function sourceReadSpan(
  read: { start: number; end: number },
  numFrames: number,
  pad?: { before: number; after: number },
): { startFrame: number; endFrame: number } {
  const span = Math.max(1, read.end - read.start);
  const start = ((read.start % numFrames) + numFrames) % numFrames;
  const before = pad ? pad.before : span;
  const after = pad ? pad.after : span;
  return { startFrame: Math.max(0, start - before), endFrame: Math.min(numFrames, start + span + after) };
}

/**
 * What one step of a dab reads of another file: the source frames `read`
 * spans while the dab writes the destination frames `dest`, mapped linearly
 * one onto the other. `dest` runs past `destFrames` when the dab wraps.
 */
export type SourceRead = {
  fileId: string;
  /** The step that reads, by its index among the brush's steps. */
  step: number;
  wantOriginal: boolean;
  /**
   * A read of the painted file itself, far from the dab: the step it is, and
   * which state of the file it takes.
   */
  self?: { step: number; state: SelfState };
  /** True for the brush's first enabled step, whose input a warp may read apart from the rest. */
  first?: boolean;
  /** Source frames the dab's effects read around what it reads, when known. */
  pad?: { before: number; after: number };
  read: { start: number; end: number };
  dest: { start: number; end: number };
  numFrames: number;
  destFrames: number;
};

/** The source frames `read` samples while its dab writes `part` of the destination. */
function readOfPart(read: SourceRead, part: { start: number; end: number }): { start: number; end: number } {
  const length = read.dest.end - read.dest.start;
  if (length <= 0) return read.read;
  // A dab that wraps writes past one end of the file as frames at the other.
  let { start, end } = part;
  if (end <= read.dest.start) {
    start += read.destFrames;
    end += read.destFrames;
  } else if (start >= read.dest.end) {
    start -= read.destFrames;
    end -= read.destFrames;
  }
  start = Math.min(read.dest.end, Math.max(read.dest.start, start));
  end = Math.min(read.dest.end, Math.max(start, end));
  const scale = (read.read.end - read.read.start) / length;
  return {
    start: read.read.start + (start - read.dest.start) * scale,
    end: read.read.start + (end - read.dest.start) * scale,
  };
}

/**
 * The destination frames a dab's reads are taken at: one span for every step,
 * or the first step's apart from the rest's, where a warp moves the first
 * step's input away from what the dab writes.
 */
export type ReadPart =
  | { start: number; end: number }
  | { first: { start: number; end: number }; rest: { start: number; end: number } };

/**
 * The windows a dab's `reads` ask for while it reads `part` of the
 * destination, or all of it when `part` is null: one per file, over what
 * every step reading that file needs.
 */
export function sourceNeedsOver(reads: readonly SourceRead[], part: ReadPart | null): SourceNeed[] {
  const needs = new Map<string, SourceNeed>();
  for (const read of reads) {
    const at = part && "first" in part ? (read.first ? part.first : part.rest) : part;
    const span = sourceReadSpan(at ? readOfPart(read, at) : read.read, read.numFrames, read.pad);
    const held = needs.get(read.fileId);
    const self = read.self ? { self: true } : {};
    needs.set(
      read.fileId,
      held
        ? {
            fileId: read.fileId,
            startFrame: Math.min(held.startFrame, span.startFrame),
            endFrame: Math.max(held.endFrame, span.endFrame),
            wantOriginal: held.wantOriginal || read.wantOriginal,
            ...self,
          }
        : { fileId: read.fileId, ...span, wantOriginal: read.wantOriginal, ...self },
    );
  }
  return [...needs.values()];
}

/** The block grid a file is cut on. */
function gridOf(spectrogram: SpectrogramData): BlockGrid {
  const { numBands, metadata, numFrames, sampleRate } = spectrogram;
  return blockGrid({ numBands, metadata }, numFrames, sampleRate);
}

/**
 * A window over a file a brush paints FROM.
 *
 * The source file's own canvas holds whatever span its own brush left it on,
 * so a destination reading through it would be served that span and clamped at
 * the edges. This is the destination's own window over the source, placed by
 * the frames the brush reads.
 *
 * The window holds the source file's committed state. Its original is a
 * second window, built the first time a step asks to read it.
 */
export class SourceWindow {
  readonly fileId: string;
  private readonly gl: WebGLRenderer;
  private readonly blocks: SourceFileBlocks;
  readonly grid: BlockGrid;
  /** Blocks the window holds at once. */
  readonly windowBlocks: number;
  private readonly current: PackedWindow;
  private original: PackedWindow | null = null;
  private metadataTex: DataTexture | null = null;
  private held: CanvasView | null = null;
  private request: CanvasView | null = null;
  private fill: Promise<void> | null = null;
  private disposed = false;

  constructor(gl: WebGLRenderer, fileId: string, blocks: SourceFileBlocks, windowBlocks?: number) {
    this.gl = gl;
    this.fileId = fileId;
    this.blocks = blocks;
    this.grid = gridOf(blocks.spectrogram);
    this.windowBlocks = Math.min(windowBlocks ?? canvasWindowBlocks(this.grid), this.grid.blockCount);
    this.current = new PackedWindow(gl, this.grid, {
      windowBlocks: this.windowBlocks,
      read: blocks.readCurrent,
      readBlock: blocks.readCurrentBlock,
    });
  }

  /** True when a window over the file serves less than all of it. */
  static isNeeded(spectrogram: SpectrogramData, windowBlocks?: number): boolean {
    const grid = gridOf(spectrogram);
    return needsCanvasWindow(grid, windowBlocks ?? canvasWindowBlocks(grid));
  }

  /** The span the textures lay out, or null while they lay out nothing. */
  get view(): CanvasView | null {
    return this.held;
  }

  /** Bytes the window's slots and composed textures hold. */
  get allocatedBytes(): number {
    return this.current.allocatedBytes + (this.original?.allocatedBytes ?? 0);
  }

  /** The textures to sample the window through, or null until it holds a span. */
  textures(): SourceWindowTextures | null {
    const view = this.held;
    // The texture takes a newly read view a step before this window does.
    if (!view || !this.metadataTex || !this.current.holds(view)) return null;
    const original = this.original?.holds(view) ? this.original.texture : undefined;
    return { packed: this.current.renderTarget, metadata: this.metadataTex, view, original };
  }

  /**
   * True while the textures hold every frame of [startFrame, endFrame), and
   * the original too when `wantOriginal`. False for a span wider than the
   * window: a read past its edges would take the edge's values.
   */
  holdsFrames(startFrame: number, endFrame: number, wantOriginal: boolean): boolean {
    const view = this.held;
    if (!view || !this.current.holds(view)) return false;
    if (wantOriginal && !(this.original?.holds(view) ?? false)) return false;
    const first = blockOfFrame(this.grid, startFrame);
    const last = blockOfFrame(this.grid, Math.max(startFrame, endFrame - 1));
    return first >= view.firstBlock && last <= view.lastBlock;
  }

  /**
   * Points the window at the frames [startFrame, endFrame). Blocks it lacks
   * are read in the background and taken when they land, so a brush ahead of
   * the reads keeps painting on what the window already holds.
   */
  aim(startFrame: number, endFrame: number, wantOriginal: boolean): void {
    if (this.disposed) return;
    const next = this.current.plan(startFrame, endFrame);
    const original = wantOriginal ? this.originalWindow() : this.original;
    const wanted = wantOriginal ? (original?.holds(next) ?? false) : true;
    if (this.held === next && wanted) return;
    const pending = this.request;
    if (pending && pending.firstBlock === next.firstBlock && pending.lastBlock === next.lastBlock) return;
    this.request = next;
    const reads = Promise.all([
      this.current.hold(next),
      wantOriginal && original ? original.hold(next) : Promise.resolve(true),
    ]);
    const filling = reads.then(([filled, originalFilled]) => {
      if (this.disposed || this.request !== next) return;
      this.request = null;
      if (!filled || !originalFilled) return;
      this.takeView(next);
    });
    const tracked = filling.then(() => {
      if (this.fill === tracked) this.fill = null;
    });
    this.fill = tracked;
  }

  /** The read in flight, or null while nothing is being read. */
  settled(): Promise<void> | null {
    return this.fill;
  }

  /** Drops every block, so the next aim reads again. */
  invalidate(): void {
    this.current.invalidate();
    this.original?.invalidate();
    this.held = null;
    this.request = null;
  }

  dispose(): void {
    this.disposed = true;
    this.held = null;
    this.request = null;
    this.current.dispose();
    this.original?.dispose();
    this.metadataTex?.dispose();
    this.metadataTex = null;
  }

  private originalWindow(): PackedWindow {
    if (!this.original) {
      this.original = new PackedWindow(this.gl, this.grid, {
        windowBlocks: this.windowBlocks,
        read: this.blocks.readRoot,
        readBlock: this.blocks.readRootBlock,
      });
    }
    return this.original;
  }

  /** Takes the view's own band table, which the shaders address the window through. */
  private takeView(view: CanvasView): void {
    this.held = view;
    this.metadataTex?.dispose();
    this.metadataTex = bandMetadataTexture(view.layout, this.grid.sampleRate);
  }
}

/**
 * One window over another file, kept pointed at whichever file the brush names
 * for it. A canvas keeps one of these per role: the file a step paints from,
 * and the file a convolve step takes its impulse response from. The window
 * holds `floor` blocks, and grows when a read spans more, up to what `most`
 * allows for that file.
 */
export class SourceWindowSlot {
  private readonly gl: WebGLRenderer;
  private readonly floor: number;
  private readonly most: (grid: BlockGrid) => number;
  private window: SourceWindow | null = null;
  private revision = 0;

  constructor(gl: WebGLRenderer, floor: number, most: (grid: BlockGrid) => number = () => floor) {
    this.gl = gl;
    this.floor = floor;
    this.most = most;
  }

  /**
   * Points the window at the frames the need asks for, building it on first
   * use, growing it when `grow` and the need spans more blocks than it holds,
   * and re-reading it once that file's committed state moves. Returns the
   * textures to sample through, or null while the window cannot serve them.
   */
  aim(need: SourceNeed, blocks: SourceFileBlocks, grow = true): SourceWindowTextures | null {
    if (this.window && this.window.fileId !== need.fileId) {
      this.window.dispose();
      this.window = null;
    }
    const grid = this.window?.grid ?? gridOf(blocks.spectrogram);
    const spans =
      blockOfFrame(grid, Math.max(need.startFrame, need.endFrame - 1)) - blockOfFrame(grid, need.startFrame) + 1;
    const most = this.most(grid);
    let size = grow ? Math.max(this.floor, spans) : this.floor;
    if (grow && this.window && spans > this.window.windowBlocks && this.window.windowBlocks < most) {
      size = Math.max(size, 2 * this.window.windowBlocks);
      this.window.dispose();
      this.window = null;
    }
    if (!this.window) {
      this.window = new SourceWindow(this.gl, need.fileId, blocks, Math.min(most, size));
      this.revision = blocks.revision();
      diag.info("canvas", "other-file window", {
        blocks: this.window.windowBlocks,
        most,
        bytes: this.window.allocatedBytes,
      });
    }
    const revision = blocks.revision();
    if (revision !== this.revision) {
      this.revision = revision;
      this.window.invalidate();
    }
    this.window.aim(need.startFrame, need.endFrame, need.wantOriginal);
    return this.holds(need) ? this.window.textures() : null;
  }

  /** True while the window holds what the need asks of it. */
  holds(need: SourceNeed | null): boolean {
    if (!need) return true;
    const window = this.window;
    if (window?.fileId !== need.fileId) return false;
    return window.holdsFrames(need.startFrame, need.endFrame, need.wantOriginal);
  }

  /** Resolves once the reads in flight have landed, or null when none are. */
  settled(): Promise<void> | null {
    return this.window?.settled() ?? null;
  }

  /** Bytes the window's slots and composed textures hold. */
  get allocatedBytes(): number {
    return this.window?.allocatedBytes ?? 0;
  }

  dispose(): void {
    this.window?.dispose();
    this.window = null;
  }
}
