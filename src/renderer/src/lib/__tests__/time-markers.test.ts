import { describe, expect, it } from "vitest";
import { computeTimeMarkers } from "../time-markers";

const base = { zoom: 0, offset: 0, bpm: 120, gridSizeBeats: 0.25, widthPx: 1000 };

describe("computeTimeMarkers", () => {
  it("keeps one tick per beat when they fit", () => {
    const markers = computeTimeMarkers({ ...base, totalDuration: 30 });
    // 30s at 120bpm = 60 beats, ~16.7px apart at 1000px.
    expect(markers.length).toBeGreaterThanOrEqual(59);
    expect(markers.length).toBeLessThanOrEqual(61);
  });

  it("bounds the tick count by width however long the file is", () => {
    for (const totalDuration of [300, 3000, 30000]) {
      const markers = computeTimeMarkers({ ...base, totalDuration });
      expect(markers.length).toBeLessThanOrEqual(1000 / 6 + 2);
    }
  });

  it("keeps labels on drawn ticks and under the label cap", () => {
    const markers = computeTimeMarkers({ ...base, totalDuration: 300 });
    const labelled = markers.filter((m) => m.label !== "");
    expect(labelled.length).toBeGreaterThan(0);
    expect(labelled.length).toBeLessThanOrEqual(21);
    for (const m of labelled) expect(m.isTick).toBe(false);
  });

  it("labels carry bar.beat text", () => {
    const markers = computeTimeMarkers({ ...base, totalDuration: 30 });
    const labelled = markers.filter((m) => m.label !== "");
    expect(labelled[0].label).toMatch(/^\d+\.\d$/);
  });
});
