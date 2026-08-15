import { C0_HZ } from "@renderer/lib/scale-snap";
import { BRUSH_SIZE_PITCH_FULL, BRUSH_SIZE_TIME_FULL } from "@renderer/lib/utils";
import { createMockSpectrogramData } from "@renderer/test/mock-spectrogram";
import { createMockState } from "@renderer/test/mock-state";
import type { State } from "@renderer/store/types";
import { describe, expect, it } from "vitest";
import { resolveGridFill, type GridFillTarget } from "../grid-fill";

// 48 frames at 48 samples/sec is one second, which is two beats at 120bpm. One
// band per semitone from C0 makes the pitch axis three plain octaves.
const spectrogramData = createMockSpectrogramData({
  numFrames: 48,
  numBands: 36,
  sampleRate: 48,
  bandsPerOctave: 12,
  minFreq: C0_HZ,
});

const target = (region: GridFillTarget["region"] = null): GridFillTarget => ({
  fileId: "mock-file",
  spectrogramData,
  bpm: 120,
  totalDuration: 1,
  region,
});

function stateWith(overrides: Partial<State> = {}): State {
  return createMockState({
    gridSizeBeats: 1,
    gridSizeSemis: 12,
    gridSwing: 0,
    snapTime: true,
    snapPitch: true,
    scaleTonic: "C",
    scaleType: "major",
    ...overrides,
  });
}

/** Brush size lives on the step, so tests that vary it must write the step too. */
function withBrushSize(state: State, sizeTime: number, sizePitch: number): State {
  const brush = state.brushes[0];
  const step: Record<string, unknown> = { ...brush.steps[0] };
  step.brushSizeTime = sizeTime;
  step.brushSizePitch = sizePitch;
  return {
    ...state,
    brushSizeTime: sizeTime,
    brushSizePitch: sizePitch,
    brushes: [{ ...brush, steps: [step] as typeof brush.steps }],
  };
}

describe("resolveGridFill", () => {
  it("paints one stroke per grid cell across time and pitch", () => {
    // Two beats of time, three octaves of pitch at a 12-semitone grid.
    const { anchors } = resolveGridFill(stateWith(), target());
    expect(anchors).toHaveLength(2 * 3);
  });

  it("covers only the loop region when one is set", () => {
    const whole = resolveGridFill(stateWith(), target()).anchors.length;
    const { anchors } = resolveGridFill(stateWith(), target({ start: 0, end: 0.5 }));
    expect(anchors.length).toBe(whole / 2);
    // Everything the fill places starts inside the region.
    expect(anchors.every((anchor) => anchor.blX < 0.5 + 1e-6)).toBe(true);
  });

  it("collapses an axis to one stroke when its snapping is off", () => {
    const state = withBrushSize(stateWith({ snapTime: false }), 0, 0);
    const { anchors, state: painted } = resolveGridFill(state, target());
    // One column of three pitch rows, each spanning the whole file in time.
    expect(anchors).toHaveLength(3);
    expect(painted.brushSizeTime).toBe(BRUSH_SIZE_TIME_FULL);
  });

  it("makes a single stroke covering everything when both axes are unsnapped", () => {
    const state = withBrushSize(stateWith({ snapTime: false, snapPitch: false }), 0, 0);
    const { anchors, state: painted } = resolveGridFill(state, target());
    expect(anchors).toHaveLength(1);
    expect(painted.brushSizeTime).toBe(BRUSH_SIZE_TIME_FULL);
    expect(painted.brushSizePitch).toBe(BRUSH_SIZE_PITCH_FULL);
  });

  it("measures an unsnapped axis against the region rather than the file", () => {
    const state = withBrushSize(stateWith({ snapTime: false }), 0, 0);
    const { state: painted } = resolveGridFill(state, target({ start: 0, end: 0.5 }));
    // Half of a one-second file at 120bpm is one beat, not the whole-file Full.
    expect(painted.brushSizeTime).toBeCloseTo(1, 5);
  });

  it("puts a stroke on every scale note when the pitch grid is set to Scale", () => {
    const state = stateWith({ gridSizeSemis: 0, snapTime: false });
    const { anchors } = resolveGridFill(state, target());
    // Three octaves of a seven-note scale.
    expect(anchors).toHaveLength(21);
  });

  it("leaves the brush untouched when both axes snap", () => {
    const state = stateWith();
    const { state: painted } = resolveGridFill(state, target());
    expect(painted).toBe(state);
  });
});
