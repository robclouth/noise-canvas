import { describe, expect, it, vi } from "vitest";
import { cleanStrokeFailures, installInputMonitor, runCleanLeg } from "../../../../../scripts/window-check-input";
import {
  expectedStrokeSpan,
  scriptedPositions,
  type StrokeFootprint,
} from "../../../../../scripts/window-check-footprint";

function recordStroke(nativeTypes: string[] = []) {
  const monitor = installInputMonitor();
  const scripted = { clientX: 1139, clientY: 954, screenX: 1139, screenY: 954 };
  const native = { ...scripted, screenX: 1843, screenY: 1228, buttons: 0 };
  try {
    window.dispatchEvent(new MouseEvent("mousemove", native));
    monitor.begin();
    window.dispatchEvent(new PointerEvent("pointerdown", { ...scripted, buttons: 1 }));
    for (const type of nativeTypes) {
      const EventType = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      window.dispatchEvent(new EventType(type, native));
    }
    window.dispatchEvent(new MouseEvent("mousemove", { ...scripted, buttons: 1 }));
    window.dispatchEvent(new MouseEvent("mouseup", scripted));
    monitor.end();
    window.dispatchEvent(new MouseEvent("mousemove", native));
    return { input: monitor.read() };
  } finally {
    monitor.dispose();
  }
}

const full: StrokeFootprint = { ranges: 153, pixels: 2115351, bounds: expectedStrokeSpan(), line: "fixture" };

describe("window-check input", () => {
  it.each(["pointermove", "mousemove", "pointerup", "mouseup"])(
    "records a native %s without ending the driver's interval",
    (type) => {
      const { input } = recordStroke([type]);
      expect(input[1]).toMatchObject({ type, origin: "native", duringStroke: true, buttons: 0 });
      expect(input[2]).toMatchObject({ origin: "scripted", duringStroke: true, buttons: 1 });
      expect(input.at(-1)).toMatchObject({ origin: "native", duringStroke: false });
    },
  );

  it("removes its page listeners on disposal", () => {
    const monitor = installInputMonitor();
    monitor.dispose();
    window.dispatchEvent(new MouseEvent("mousemove"));
    expect(monitor.read()).toEqual([]);
  });

  it("discards a contaminated leg and returns only the fresh attempt", async () => {
    const contaminated = { ...recordStroke(["mousemove"]), footprints: [full] };
    const clean = { ...recordStroke(), footprints: [full] };
    const attempt = vi.fn().mockResolvedValueOnce(contaminated).mockResolvedValueOnce(clean);
    const report = vi.fn();
    expect(await runCleanLeg("whole file", attempt, report)).toBe(clean);
    expect(attempt.mock.calls).toEqual([[1], [2]]);
    expect(report).toHaveBeenCalledWith(expect.stringContaining("discarded attempt 1"));
    expect(report).toHaveBeenCalledWith(expect.stringContaining("rerunning the leg in a fresh app"));
  });

  it("stops after three contaminated attempts with an actionable message", async () => {
    const attempt = vi.fn().mockResolvedValue(recordStroke(["pointermove", "mousemove"]));
    await expect(runCleanLeg("windowed", attempt, vi.fn())).rejects.toThrow(
      "native input reached the window on all 3 attempts. Leave the machine alone while the guard runs.",
    );
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("does not retry a short stroke without native input during the drag", async () => {
    const short = { ...full, bounds: expectedStrokeSpan(scriptedPositions.slice(0, 11)), pixels: 843015 };
    const attempt = vi.fn(async () => ({ ...recordStroke(), footprints: [short] }));
    const result = await runCleanLeg("whole file", attempt, vi.fn());
    const failures = cleanStrokeFailures(result.footprints);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(failures[0]).toContain("left end");
    expect(failures[0]).toContain("right end");
    expect(failures[0]).toContain("no native input was detected");
    expect(failures[1]).toContain("below the reference floor of 2100000");
  });

  it("keeps the count, span and floor assertions for every clean leg", () => {
    expect(cleanStrokeFailures([full])).toEqual([]);
    expect(cleanStrokeFailures([])[0]).toContain("committed nothing");
    expect(cleanStrokeFailures([full, full])[0]).toContain("2 commits; expected one");
    expect(cleanStrokeFailures([{ ...full, pixels: 2099999 }])[0]).toContain("below the reference floor");
    expect(cleanStrokeFailures([{ ...full, bounds: expectedStrokeSpan(scriptedPositions.slice(0, -1)) }])[0]).toContain(
      "left end",
    );
  });

  it("never retries an unrelated attempt failure", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("the app failed"));
    await expect(runCleanLeg("windowed", attempt, vi.fn())).rejects.toThrow("the app failed");
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
