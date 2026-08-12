import type { StampMarker } from "@renderer/lib/generate/stamp-layout";
import {
  MIN_LABEL_HEIGHT_PX,
  MIN_LABEL_WIDTH_PX,
  fitsLabel,
  isOnLane,
  stampBox,
} from "@renderer/lib/generate/stamp-overlay";
import { Vector2 } from "three";
import { describe, expect, it } from "vitest";

const NO_ZOOM = new Vector2(0, 0);
const NO_OFFSET = new Vector2(0, 0);

function marker(overrides: Partial<StampMarker> = {}): StampMarker {
  return {
    blX: 0.25,
    blY: 0.5,
    sizeX: 0.1,
    sizeY: 0.25,
    brushIndex: 0,
    brushName: "Paint Noise",
    color: { hue: "blue", variation: 0 },
    labels: [],
    ...overrides,
  };
}

describe("stamp overlay geometry", () => {
  it("puts a stamp's high-pitch edge at the top of its box", () => {
    const box = stampBox(marker(), NO_ZOOM, NO_OFFSET);
    // blY 0.5 + sizeY 0.25 reaches 0.75 of the way up, which is a quarter down.
    expect(box.top).toBeCloseTo(0.25, 10);
    expect(box.height).toBeCloseTo(0.25, 10);
    expect(box.left).toBeCloseTo(0.25, 10);
    expect(box.width).toBeCloseTo(0.1, 10);
  });

  it("draws a stamp on the lowest band at the bottom of the lane", () => {
    const box = stampBox(marker({ blY: 0, sizeY: 0.2 }), NO_ZOOM, NO_OFFSET);
    expect(box.top + box.height).toBeCloseTo(1, 10);
  });

  it("covers the lane when a stamp spans the whole file", () => {
    const box = stampBox(marker({ blX: 0, blY: 0, sizeX: 1, sizeY: 1 }), NO_ZOOM, NO_OFFSET);
    expect(box.left).toBeCloseTo(0, 10);
    expect(box.top).toBeCloseTo(0, 10);
    expect(box.width).toBeCloseTo(1, 10);
    expect(box.height).toBeCloseTo(1, 10);
  });

  it("keeps a box under the zoom the canvas is at", () => {
    // One octave of zoom on time, parked at the left edge: the first half of
    // the file fills the lane, so a stamp at 0.25 sits at the middle.
    const box = stampBox(marker(), new Vector2(1, 0), new Vector2(0, 0));
    expect(box.left).toBeCloseTo(0.5, 10);
    expect(box.width).toBeCloseTo(0.2, 10);
  });

  it("reports a box scrolled off the lane", () => {
    expect(isOnLane({ left: 1.2, top: 0.1, width: 0.1, height: 0.1 })).toBe(false);
    expect(isOnLane({ left: -0.3, top: 0.1, width: 0.1, height: 0.1 })).toBe(false);
    expect(isOnLane({ left: 0.1, top: -0.5, width: 0.1, height: 0.1 })).toBe(false);
    expect(isOnLane({ left: -0.05, top: 0.1, width: 0.1, height: 0.1 })).toBe(true);
  });

  it("labels a box only once it has room on both axes", () => {
    const lane = { width: 1000, height: 400 };
    const wide = { left: 0, top: 0, width: MIN_LABEL_WIDTH_PX / lane.width, height: 0.5 };
    expect(fitsLabel(wide, lane.width, lane.height)).toBe(true);

    const narrow = { ...wide, width: (MIN_LABEL_WIDTH_PX - 1) / lane.width };
    expect(fitsLabel(narrow, lane.width, lane.height)).toBe(false);

    const short = { ...wide, height: (MIN_LABEL_HEIGHT_PX - 1) / lane.height };
    expect(fitsLabel(short, lane.width, lane.height)).toBe(false);
  });
});
