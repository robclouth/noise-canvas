import { describe, expect, it } from "vitest";

import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { blockGrid, frameRangeOfBlock } from "../block-grid";
import { blockReadSpan, blocksOfDab, HeldDabs, type DabExtent, type FrameSpan } from "../held-dabs";

const data = createConstantQMockSpectrogramData({ durationSeconds: 16, sampleRate: 8000, bandsPerOctave: 4 });
const grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, 8000);
const B = grid.blockFrames;

function extent(start: number, end: number, reach = 0, readsLive = false): DabExtent {
  return { writes: [{ start, end }], before: reach, after: reach, readsLive, piece: { before: reach, after: reach } };
}

describe("held dabs", () => {
  it("cuts a file into enough blocks to test with", () => {
    expect(grid.blockCount).toBeGreaterThanOrEqual(6);
  });

  it("names the blocks a dab writes, both ends of one that wraps", () => {
    expect(blocksOfDab(grid, extent(B + 10, 3 * B - 10))).toEqual([1, 2]);
    const wrapped: DabExtent = {
      writes: [
        { start: data.numFrames - 10, end: data.numFrames },
        { start: 0, end: 10 },
      ],
      before: 0,
      after: 0,
      readsLive: false,
      piece: { before: 0, after: 0 },
    };
    expect(blocksOfDab(grid, wrapped)).toEqual([0, grid.blockCount - 1]);
  });

  it("reads around the part of a block a dab writes, and a bin past a cut", () => {
    const small = extent(B + 100, B + 200, 50);
    expect(blockReadSpan(grid, small, 1)).toEqual({ start: B + 50, end: B + 250 });
    const wide = extent(B + 100, 3 * B, 0);
    const margin = B / Math.min(...grid.binsPerBlock);
    expect(blockReadSpan(grid, wide, 1)).toEqual({ start: B + 100, end: 2 * B + margin });
    expect(blockReadSpan(grid, wide, 2)).toEqual({ start: 2 * B - margin, end: 3 * B });
  });

  it("reads around each piece as far as the dab reads from a pixel, or all of it for a dab painted whole", () => {
    const wide = { ...extent(B + 100, 3 * B, 0), piece: { before: 40, after: 60 } };
    const margin = B / Math.min(...grid.binsPerBlock);
    expect(blockReadSpan(grid, wide, 2)).toEqual({ start: 2 * B - 40 - margin, end: 3 * B + 60 });
    const whole = { ...extent(B + 100, 3 * B, 20), piece: null };
    expect(blockReadSpan(grid, whole, 2)).toEqual({ start: B + 80, end: 3 * B + 20 });
  });

  it("paints what the canvas holds at once, a run of blocks at a time, and waits only on the same block", () => {
    const held = new HeldDabs<string>(grid);
    const painted: { dab: string; clip: FrameSpan | null }[] = [];
    const push = (name: string, dab: DabExtent) =>
      held.push(dab, name, (clip) => {
        painted.push({ dab: name, clip });
        return true;
      });
    push("wide", extent(0, 4 * B));
    push("over", extent(3 * B + 10, 3 * B + 20));
    push("apart", extent(5 * B + 10, 5 * B + 20));
    // The canvas holds blocks 0, 1 and 5.
    const onCanvas = new Set([0, 1, 5]);
    const holds = (dab: DabExtent, _: string, block: number): boolean => {
      const read = blockReadSpan(grid, dab, block);
      for (let b = Math.floor(read.start / B); b <= Math.floor((read.end - 1) / B); b++)
        if (!onCanvas.has(b)) return false;
      return true;
    };
    held.release(holds);
    // Block 1 of the wide dab needs a bin of block 2, so only block 0 goes;
    // the dab on block 5 does not wait for it.
    expect(painted).toEqual([
      { dab: "wide", clip: frameRangeOfBlock(grid, 0) },
      { dab: "apart", clip: null },
    ]);
    expect(held.pieces).toBe(4);
    // The rest of the wide dab lands; the dab over its block 3 only after it.
    for (const b of [1, 2, 3, 4]) onCanvas.add(b);
    painted.length = 0;
    held.release(holds);
    expect(painted).toEqual([
      { dab: "wide", clip: { start: B, end: 4 * B } },
      { dab: "over", clip: null },
    ]);
    expect(held.size).toBe(0);
  });

  it("holds a dab that reads the canvas as it is left behind every older block within its reach", () => {
    const held = new HeldDabs<string>(grid);
    const painted: string[] = [];
    held.push(extent(2 * B + 10, 2 * B + 20), "older", () => {
      painted.push("older");
      return true;
    });
    held.push(extent(3 * B + 10, 3 * B + 20, B, true), "live", () => {
      painted.push("live");
      return true;
    });
    held.push(extent(4 * B + 10, 4 * B + 20, B, false), "start", () => {
      painted.push("start");
      return true;
    });
    held.push(extent(5 * B + 10, 5 * B + 20, B, false), "apart", () => {
      painted.push("apart");
      return true;
    });
    // The older dab cannot paint yet. The live dab reads its block, so it
    // waits; the next writes where the live dab still has to read, so it
    // waits too. The last reads the canvas as the stroke found it, clear of
    // both, and goes ahead.
    held.release((_, name) => name !== "older");
    expect(painted).toEqual(["apart"]);
    held.release(() => true);
    expect(painted).toEqual(["apart", "older", "live", "start"]);
  });

  it("paints a dab that asks for it a block at a time, each block clipped, even when all of it is ready", () => {
    const held = new HeldDabs<string>(grid);
    const clips: (FrameSpan | null)[] = [];
    held.push(
      extent(B + 10, 3 * B - 10),
      "apart",
      (clip) => {
        clips.push(clip);
        return true;
      },
      { byBlock: true },
    );
    held.release(() => true);
    expect(clips).toEqual([frameRangeOfBlock(grid, 1), frameRangeOfBlock(grid, 2)]);
  });

  it("holds a dab off a block that an older dab reading the canvas as it is left still has to read", () => {
    const held = new HeldDabs<string>(grid);
    const painted: string[] = [];
    held.push(extent(3 * B + 10, 3 * B + 20, B, true), "reader", () => {
      painted.push("reader");
      return true;
    });
    held.push(extent(2 * B + 10, 2 * B + 20), "writer", () => {
      painted.push("writer");
      return true;
    });
    held.release((_, name) => name !== "reader");
    expect(painted).toEqual([]);
    held.release(() => true);
    expect(painted).toEqual(["reader", "writer"]);
  });

  it("holds every later dab back until a dab held with holdsBack has painted all of it", () => {
    const held = new HeldDabs<string>(grid);
    const painted: string[] = [];
    let ready = false;
    held.push(extent(B + 10, B + 20), "beside", () => ready && painted.push("beside") > 0, { holdsBack: true });
    held.push(extent(4 * B + 10, 4 * B + 20), "apart", () => painted.push("apart") > 0);
    held.release(() => true);
    expect(painted).toEqual([]);
    expect(held.target(() => true)?.payloads).toEqual(["beside"]);
    ready = true;
    held.release(() => true);
    expect(painted).toEqual(["beside", "apart"]);
  });

  it("keeps a run that could not paint for the next release", () => {
    const held = new HeldDabs<string>(grid);
    let ready = false;
    held.push(extent(B + 10, B + 20), "late", () => ready);
    held.release(() => true);
    expect(held.pieces).toBe(1);
    ready = true;
    held.release(() => true);
    expect(held.size).toBe(0);
  });

  it("aims at the oldest waiting block and widens over what follows while a window fits", () => {
    const held = new HeldDabs<string>(grid);
    held.push(extent(B + 10, B + 20), "first", () => true);
    held.push(extent(2 * B + 10, 2 * B + 20), "second", () => true);
    held.push(extent(5 * B + 10, 5 * B + 20), "far", () => true);
    const target = held.target((start, end) => Math.floor((end - 1) / B) - Math.floor(start / B) + 1 <= 2);
    expect(target).toEqual({
      span: { start: B + 10, end: 2 * B + 20 },
      payloads: ["first", "second"],
      part: { start: B + 10, end: B + 20 },
    });
  });
});
