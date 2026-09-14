import { describe, expect, it, vi } from "vitest";
import { ViewSnapshot } from "../view-snapshot";

function deferredCapture() {
  let finish: (ok: boolean) => void = () => {};
  let canPublish: () => boolean = () => false;
  const draw = vi.fn((current: () => boolean) => {
    canPublish = current;
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  });
  return { draw, finish: (ok: boolean) => finish(ok), canPublish: () => canPublish() };
}

describe("view snapshot revisions", () => {
  it("shares an in-flight capture and requests the newest revision once", async () => {
    const request = vi.fn();
    const snapshot = new ViewSnapshot(request);
    const pending = deferredCapture();
    const first = snapshot.capture(pending.draw);
    expect(snapshot.capture(pending.draw)).toBe(first);
    expect(pending.draw).toHaveBeenCalledTimes(1);
    expect(pending.canPublish()).toBe(true);
    snapshot.invalidate();
    snapshot.invalidate();
    expect(pending.canPublish()).toBe(false);
    pending.finish(true);
    expect(await first).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await snapshot.capture(async (current) => current())).toBe(true);
  });

  it("prevents a disposed view from publishing or scheduling another capture", async () => {
    const request = vi.fn();
    const snapshot = new ViewSnapshot(request);
    const pending = deferredCapture();
    const capture = snapshot.capture(pending.draw);
    snapshot.invalidate();
    snapshot.dispose();
    expect(pending.canPublish()).toBe(false);
    pending.finish(true);
    expect(await capture).toBe(false);
    expect(await snapshot.capture(pending.draw)).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(pending.draw).toHaveBeenCalledTimes(1);
  });

  it("does not loop on a failed read and permits a later request", async () => {
    const request = vi.fn();
    const snapshot = new ViewSnapshot(request);
    await expect(
      snapshot.capture(async () => {
        throw new Error("read failed");
      }),
    ).rejects.toThrow("read failed");
    expect(request).not.toHaveBeenCalled();
    expect(await snapshot.capture(async (current) => current())).toBe(true);
  });
});
