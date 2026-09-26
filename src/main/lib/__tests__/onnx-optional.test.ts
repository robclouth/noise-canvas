import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ADDON = resolve(__dirname, "../../../../build/Release/gaborator_addon.node");

/** What `script` prints when run in a fresh Node with the addon at `addonPath`. */
function runWith(addonPath: string, script: string): string {
  const result = spawnSync(process.execPath, ["-e", `const addon = require(${JSON.stringify(addonPath)}); ${script}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe.runIf(process.platform === "darwin" && process.arch === "arm64")("ONNX Runtime on macOS", () => {
  it("opens beside the addon, so stem separation is there", () => {
    expect(runWith(ADDON, "console.log(addon.aiSeparationAvailable())")).toBe("true");
  });

  it("is not needed for the addon to load, and its absence refuses stem separation alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "addon-without-onnx-"));
    try {
      const copy = join(dir, "gaborator_addon.node");
      copyFileSync(ADDON, copy);
      const out = runWith(
        copy,
        `console.log(typeof addon.getGpuMemoryInfo, addon.aiSeparationAvailable());
         addon.aiSeparate([new Float32Array(8)], 44100, "/none.onnx", ["drums"]).catch((e) => console.log(e.message));`,
      );
      const [loaded, refusal] = out.split("\n");
      expect(loaded).toBe("function false");
      expect(refusal).toMatch(/^ONNX Runtime could not load/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
