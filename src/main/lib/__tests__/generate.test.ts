import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate, isGenerateModelDownloaded, setGenerateAddon } from "../generate";

const require = createRequire(import.meta.url);
setGenerateAddon(() => require(join(__dirname, "../../../../build/Release/gaborator_addon.node")));

/** Four seconds of a plucked tone over quiet noise, in stereo at the model's rate. */
function clip(): Float32Array[] {
  const rate = 44100;
  const left = new Float32Array(rate * 4);
  let seed = 3;
  for (let i = 0; i < left.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = (i % (rate / 2)) / rate;
    left[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t) * Math.exp(-6 * t) + (seed / 0x7fffffff - 0.5) * 0.02;
  }
  return [left, left.slice()];
}

const rms = (a: Float32Array, b?: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - (b ? b[i] : 0)) ** 2;
  return Math.sqrt(sum / a.length);
};

describe.runIf(process.platform === "darwin" && process.arch === "arm64" && isGenerateModelDownloaded())(
  "Generate through the addon",
  () => {
    it("restyles a clip into stereo audio of its length, the same take for the same seed", async () => {
      const context = clip();
      const request = { prompt: "soft rhodes chords", context, strength: 0.7, seed: 11 };
      const first = await generate(request);
      const again = await generate(request);
      const other = await generate({ ...request, seed: 12 });

      expect(first).toHaveLength(2);
      expect(first[0].length).toBe(context[0].length);
      expect(first.every((channel) => channel.every(Number.isFinite))).toBe(true);
      expect(rms(first[0])).toBeGreaterThan(1e-3);
      expect(rms(first[0], again[0])).toBeLessThan(1e-4);
      expect(rms(first[0], other[0])).toBeGreaterThan(1e-3);
    }, 240_000);
  },
);
