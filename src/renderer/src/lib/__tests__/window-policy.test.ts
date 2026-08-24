import { describe, expect, it } from "vitest";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { buildWindowLayout, fileLayoutOf, layoutPixelCount, windowAlignment } from "../window-layout";
import {
  chooseWindow,
  DEFAULT_WINDOW_POLICY,
  EXACT_ADDRESS_PIXELS,
  viewFrameSpan,
  windowCovers,
  type WindowPolicy,
} from "../window-policy";

const file = fileLayoutOf(createConstantQMockSpectrogramData({ durationSeconds: 8, sampleRate: 8000 }));
const POLICY: WindowPolicy = { marginFraction: 0.5, maxPixels: 0 };

describe("view frame span", () => {
  it("is the whole file until the view is zoomed in", () => {
    for (const offset of [0, 0.5, 1]) {
      expect(viewFrameSpan(file.numFrames, 0, offset)).toEqual({ startFrame: 0, endFrame: file.numFrames });
    }
  });

  it("halves with each zoom power and follows the offset from end to end", () => {
    for (const power of [1, 2, 5]) {
      const span = file.numFrames / 2 ** power;
      expect(viewFrameSpan(file.numFrames, power, 0).startFrame).toBe(0);
      expect(viewFrameSpan(file.numFrames, power, 1).endFrame).toBe(file.numFrames);
      const middle = viewFrameSpan(file.numFrames, power, 0.5);
      expect(middle.endFrame - middle.startFrame).toBeCloseTo(span, 0);
      expect((middle.startFrame + middle.endFrame) / 2).toBeCloseTo(file.numFrames / 2, 0);
    }
  });
});

describe("window choice", () => {
  it("holds the view with the margin on both sides", () => {
    const view = { startFrame: 20000, endFrame: 28000 };
    const next = chooseWindow(file, view.startFrame, view.endFrame, null, POLICY);
    expect(next).not.toBeNull();
    if (!next) return;
    const margin = (view.endFrame - view.startFrame) * POLICY.marginFraction;
    const align = windowAlignment(file);
    expect(view.startFrame - next.startFrame).toBeGreaterThanOrEqual(margin - align);
    expect(next.endFrame - view.endFrame).toBeGreaterThanOrEqual(margin - align);
  });

  it("keeps the window while the view stays inside it", () => {
    const current = chooseWindow(file, 20000, 28000, null, POLICY);
    expect(current).not.toBeNull();
    if (!current) return;
    // Anywhere in the margin, which is exactly what the margin buys.
    expect(chooseWindow(file, current.startFrame, current.endFrame, current, POLICY)).toBeNull();
    expect(chooseWindow(file, 21000, 27000, current, POLICY)).toBeNull();
  });

  it("moves as soon as the view leaves it", () => {
    const current = chooseWindow(file, 20000, 28000, null, POLICY);
    expect(current).not.toBeNull();
    if (!current) return;
    const next = chooseWindow(file, current.startFrame - 1, current.endFrame, current, POLICY);
    expect(next).not.toBeNull();
    expect(next?.startFrame).toBeLessThan(current.startFrame);
  });

  it("does not move when the choice would land where it already is", () => {
    const whole = buildWindowLayout(file, 0, file.numFrames);
    expect(chooseWindow(file, 0, file.numFrames, whole, POLICY)).toBeNull();
  });

  it("clamps to the file at both ends", () => {
    const atStart = chooseWindow(file, 0, 4000, null, POLICY);
    expect(atStart?.startFrame).toBe(0);
    const atEnd = chooseWindow(file, file.numFrames - 4000, file.numFrames, null, POLICY);
    expect(atEnd?.endFrame).toBeGreaterThanOrEqual(file.numFrames);
  });

  it("stays inside the pixel cap, keeping the view's centre resident", () => {
    const whole = layoutPixelCount(buildWindowLayout(file, 0, file.numFrames));
    const policy: WindowPolicy = { marginFraction: 0.5, maxPixels: Math.floor(whole / 8) };
    const view = { startFrame: 24000, endFrame: 40000 };
    const next = chooseWindow(file, view.startFrame, view.endFrame, null, policy);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(layoutPixelCount(next)).toBeLessThanOrEqual(policy.maxPixels);
    const centre = (view.startFrame + view.endFrame) / 2;
    expect(windowCovers(next, centre - 1, centre + 1)).toBe(true);
  });

  // A packed texel is addressed by adding a band offset to a bin index in a
  // float32, and past 2^24 that sum stops naming texels one at a time.
  it("caps the window at what a float32 can address exactly", () => {
    expect(DEFAULT_WINDOW_POLICY.maxPixels).toBe(EXACT_ADDRESS_PIXELS);
    expect(Math.fround(EXACT_ADDRESS_PIXELS - 1)).toBe(EXACT_ADDRESS_PIXELS - 1);
    expect(Math.fround(EXACT_ADDRESS_PIXELS + 1)).toBe(EXACT_ADDRESS_PIXELS);
  });

  it("leaves the cap alone when the view already fits", () => {
    const whole = layoutPixelCount(buildWindowLayout(file, 0, file.numFrames));
    const policy: WindowPolicy = { marginFraction: 0.5, maxPixels: whole };
    const capped = chooseWindow(file, 20000, 28000, null, policy);
    const uncapped = chooseWindow(file, 20000, 28000, null, POLICY);
    expect(capped?.startFrame).toBe(uncapped?.startFrame);
    expect(capped?.endFrame).toBe(uncapped?.endFrame);
  });
});
