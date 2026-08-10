import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeAudioFile, encodeBufferToAudioFile } from "../ffmpeg";

/**
 * The undo history caches each state's rendered audio so revisiting it doesn't
 * re-synthesize. That cache is written as WavPack, which has to give back
 * exactly the samples it was handed — a state you undo to must sound like the
 * state you left.
 */
describe("audio cache format", () => {
  const SAMPLE_RATE = 44100;
  let dir = "";

  // Samples an integer format would not survive: sub-LSB values, values past
  // full scale (synthesis output isn't normalized), and the signed zeros.
  function makeChannel(seed: number): Float32Array {
    const out = new Float32Array(2048);
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.sin((i * (seed + 1)) / 37) * 0.5;
    }
    out[0] = 0;
    out[1] = -0;
    out[2] = 1e-9;
    out[3] = -1e-9;
    out[4] = 2.5;
    out[5] = -2.5;
    out[6] = 1 / 3;
    return out;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nc-audio-cache-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips float samples through WavPack bit-for-bit", async () => {
    const channels = [makeChannel(0), makeChannel(1)];
    const path = join(dir, "cache.wv");
    await encodeBufferToAudioFile(channels, path, SAMPLE_RATE, "wv");

    const interleaved = await decodeAudioFile(path, SAMPLE_RATE, channels.length);
    expect(interleaved.length).toBe(channels[0].length * channels.length);
    for (let frame = 0; frame < channels[0].length; frame++) {
      for (let ch = 0; ch < channels.length; ch++) {
        // Compare the bit patterns so a sign flip on zero would still fail.
        const decoded = new Float32Array([interleaved[frame * channels.length + ch]]);
        const original = new Float32Array([channels[ch][frame]]);
        expect(new Uint32Array(decoded.buffer)[0]).toBe(new Uint32Array(original.buffer)[0]);
      }
    }
  }, 30_000);

  it("is smaller than the float32 WAV it replaces", async () => {
    const channels = [makeChannel(2), makeChannel(3)];
    const wavPath = join(dir, "compare.wav");
    const wvPath = join(dir, "compare.wv");
    await encodeBufferToAudioFile(channels, wavPath, SAMPLE_RATE, "wav");
    await encodeBufferToAudioFile(channels, wvPath, SAMPLE_RATE, "wv");

    const [wav, wv] = await Promise.all([stat(wavPath), stat(wvPath)]);
    expect(wv.size).toBeLessThan(wav.size);
  }, 30_000);
});
