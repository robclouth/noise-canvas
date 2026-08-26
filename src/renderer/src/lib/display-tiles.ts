import { coarsestStepLog2, type BandLayout } from "./band-layout";

/** RG16F: left and right magnitude, in dB. */
export const DISPLAY_TILES_BYTES_PER_TEXEL = 4;

/** Texels the tile ring holds — 8 MB at RG16F, per open file, whatever the file's length. */
export const DISPLAY_TILES_MAX_TEXELS = 2_000_000;

// Screen pixels one tile covers when the band grid does not force it wider.
// Wide enough that a viewport needs few tiles, narrow enough that a pan
// re-cuts a small one.
const TILE_LOG2_PIXELS = 8;

// Tiles held beyond the ones the viewport covers, so a pan of up to a tile in
// either direction needs no cut.
const RING_SLACK_TILES = 2;

/** Below this a ring cannot hold a viewport and its slack, so the pyramid serves instead. */
const RING_MIN_SLOTS = 3;

/**
 * The ring's grid at one level: how a tile's bins are laid out inside its
 * slot, and how many frames a tile covers. Every band's bin count divides the
 * tile exactly, so no bin straddles a tile edge.
 */
export type TileGrid = {
  level: number;
  tileFrames: number;
  tileTexels: number;
  tileCount: number;
  /** RGBA per band: offset inside a slot, bins over the whole file, ring time step log2, bins per tile. */
  metadata: Float32Array;
};

/** Which level the ring holds and how far towards the next one the view sits. */
export type RingLevelChoice = { level: number; blend: number };

/**
 * The level whose bins are at least as fine as one per screen pixel, and how
 * far the view has moved towards the next coarser one. Blending the pair keeps
 * the picture from stepping as a zoom crosses a level.
 */
export function ringLevelChoice(framesPerPixel: number): RingLevelChoice {
  const wanted = Math.log2(Math.max(framesPerPixel, 1));
  const level = Math.max(Math.floor(wanted), 0);
  return { level, blend: Math.min(Math.max(wanted - level, 0), 1) };
}

/** Frames one tile covers at `level`, always a whole number of every band's bins. */
export function tileFramesFor(layout: BandLayout, level: number): number {
  return 2 ** Math.max(coarsestStepLog2(layout), level + TILE_LOG2_PIXELS);
}

/** The ring's grid for one level of `layout`. */
export function tileGrid(layout: BandLayout, numFrames: number, level: number): TileGrid {
  const tileFrames = tileFramesFor(layout, level);
  const metadata = new Float32Array(layout.numBands * 4);
  let offset = 0;
  for (let band = 0; band < layout.numBands; band++) {
    const sourceStep = layout.metadata[band * 4 + 2];
    const ringStep = Math.max(sourceStep, level);
    const binsPerTile = tileFrames / 2 ** ringStep;
    metadata[band * 4] = offset;
    metadata[band * 4 + 1] = Math.ceil(layout.metadata[band * 4 + 1] / 2 ** (ringStep - sourceStep));
    metadata[band * 4 + 2] = ringStep;
    metadata[band * 4 + 3] = binsPerTile;
    offset += binsPerTile;
  }
  return {
    level,
    tileFrames,
    tileTexels: offset,
    tileCount: Math.max(1, Math.ceil(numFrames / tileFrames)),
    metadata,
  };
}

/**
 * Slots a ring of `maxTexels` gives this grid, capped at what a viewport plus
 * its slack needs. Zero when the ring cannot hold enough of the view to be
 * worth reading.
 */
export function ringSlotCount(grid: TileGrid, viewportPixels: number, maxTexels: number): number {
  const affordable = Math.floor(maxTexels / Math.max(1, grid.tileTexels));
  const wanted = Math.ceil((viewportPixels * 2 ** grid.level) / grid.tileFrames) + RING_SLACK_TILES;
  const slots = Math.min(affordable, wanted, grid.tileCount);
  return slots < Math.min(RING_MIN_SLOTS, grid.tileCount) ? 0 : slots;
}

/**
 * The window of tiles to hold for a view over frames [startFrame, endFrame),
 * centred on it so a pan either way has slack. `current` is kept unchanged
 * while it still covers the view.
 */
export function ringWindow(
  grid: TileGrid,
  slots: number,
  startFrame: number,
  endFrame: number,
  current?: { first: number; count: number },
): { first: number; count: number } {
  if (slots <= 0) return { first: 0, count: 0 };
  const firstNeeded = Math.max(0, Math.floor(startFrame / grid.tileFrames));
  const lastNeeded = Math.min(grid.tileCount - 1, Math.floor(Math.max(startFrame, endFrame - 1) / grid.tileFrames));
  if (current && current.count > 0 && firstNeeded >= current.first && lastNeeded < current.first + current.count) {
    return current;
  }
  const count = Math.min(slots, grid.tileCount);
  const slack = Math.floor((count - (lastNeeded - firstNeeded + 1)) / 2);
  const first = Math.min(Math.max(firstNeeded - Math.max(slack, 0), 0), Math.max(grid.tileCount - count, 0));
  return { first, count };
}

/** GPU bytes a file's tile ring holds. */
export function displayTilesBytes(maxTexels = DISPLAY_TILES_MAX_TEXELS): number {
  return maxTexels * DISPLAY_TILES_BYTES_PER_TEXEL;
}
