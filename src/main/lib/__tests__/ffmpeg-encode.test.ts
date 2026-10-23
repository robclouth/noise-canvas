import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowedExtensions } from "../audio-extensions";
import { codecArgsForFormat, decodeAudioFile, encodeBufferToAudioFile, savableExtensions } from "../ffmpeg";

describe("saving every audio format", () => {
  let dir: string;
  const sampleRate = 48000;
  const left = Float32Array.from(
    { length: sampleRate / 2 },
    (_, i) => Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5,
  );
  const right = Float32Array.from(left, (v) => -v);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ffmpeg-encode-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(savableExtensions)("writes a .%s file that decodes back to the same length and level", async (format) => {
    const outputPath = join(dir, `tone.${format}`);
    await encodeBufferToAudioFile([left, right], outputPath, sampleRate, format);

    const decoded = await decodeAudioFile(outputPath, sampleRate, 2);
    const frames = decoded.length / 2;
    // Lossy codecs pad the start and end by up to a few thousand frames.
    expect(Math.abs(frames - left.length)).toBeLessThan(4096);

    let peak = 0;
    for (const v of decoded) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.4);
    expect(peak).toBeLessThan(0.6);
  });

  it("refuses a format it cannot write, naming the ones it can", () => {
    expect(() => codecArgsForFormat("ape")).toThrow(/cannot save \.ape files.*WAV/);
  });

  it("can save every format it can open, except APE", () => {
    const unsavable = allowedExtensions.filter((ext) => !savableExtensions.includes(ext));
    expect(unsavable).toEqual(["ape"]);
  });
});
