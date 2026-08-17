import { describe, expect, it } from "vitest";
import { getGaboratorPath, getGpuMemoryInfo, init } from "../audio-analysis";
import { loadNativeAddon } from "../native-addon";

// The preload hands these modules to the renderer, so the addons load in the
// renderer process too. A packaged renderer is a file:// document, where
// require()'s realpath step throws for any path outside app.asar — which is
// where the unpacked addons sit — and the exception unmounts the whole UI.
// Opening the library directly is what keeps the packaged app off a grey screen.
describe("native addon loading", () => {
  it("opens the built addon without module resolution", () => {
    const addon = loadNativeAddon<{ getGpuMemoryBytes: () => number }>(getGaboratorPath());
    expect(typeof addon.getGpuMemoryBytes()).toBe("number");
  });

  it("is how init() reaches the addon", () => {
    expect(typeof init().getGpuMemoryBytes).toBe("function");
  });

  it("reports a GPU memory budget", () => {
    const info = getGpuMemoryInfo();
    expect(info.bytes).toBeGreaterThan(0);
    expect(typeof info.unified).toBe("boolean");
  });
});
