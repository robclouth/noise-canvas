import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeBufferToAudioFile, ffmpegBinaryName, resolveFfmpegPath, runnableFromAsar } from "../ffmpeg";

/**
 * The Ableton extension's host is bundled with ffmpeg-static left external, and
 * a packaged .ablx carries no node_modules to resolve it from. The binary is
 * shipped beside the bundled entry instead, so the path must be resolved from
 * there — and resolved lazily, since a require at import time would throw
 * before the host could start.
 */

describe("resolving the ffmpeg binary", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ffmpeg-path-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers a binary sitting beside the host entry", () => {
    const beside = join(dir, ffmpegBinaryName);
    writeFileSync(beside, "");
    expect(resolveFfmpegPath(dir)).toBe(beside);
  });

  it("falls back to the ffmpeg-static package when there is none beside it", () => {
    const empty = mkdtempSync(join(tmpdir(), "ffmpeg-empty-"));
    try {
      const resolved = resolveFfmpegPath(empty);
      expect(resolved).not.toContain(empty);
      expect(resolved).toContain("ffmpeg-static");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("points Electron at the unpacked copy, which is the runnable one", () => {
    expect(runnableFromAsar("/A/app.asar/node_modules/ffmpeg-static/ffmpeg", "/A/app.asar/out/main")).toBe(
      "/A/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg",
    );
  });

  it("leaves the path alone when the build runs from no archive", () => {
    expect(runnableFromAsar("/A/node_modules/ffmpeg-static/ffmpeg", "/A/out/main")).toBe(
      "/A/node_modules/ffmpeg-static/ffmpeg",
    );
  });

  it("resolves to a binary that actually runs", () => {
    const version = execFileSync(resolveFfmpegPath(), ["-version"], { encoding: "utf8" });
    expect(version).toContain("ffmpeg version");
  });

  it("encodes with the binary it resolves", async () => {
    const outputPath = join(dir, "tone.wav");
    const samples = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 10) * 0.5);
    await encodeBufferToAudioFile([samples], outputPath, 48000, "wav");

    const probe = execFileSync(resolveFfmpegPath(), ["-hide_banner", "-i", outputPath, "-f", "null", "-"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(probe).toBeDefined();
  });
});
