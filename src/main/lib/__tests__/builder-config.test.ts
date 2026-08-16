import { readFileSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * electron-builder merges `extendInfo` into the app's Info.plist by key. Written
 * as a YAML list it merges array indices instead, which lands the usage strings
 * under keys "0", "1", "2" and leaves the real keys at electron-builder's
 * defaults — a macOS permission prompt with the wrong text, or none at all.
 */
describe("electron-builder macOS config", () => {
  const config = load(readFileSync(join(process.cwd(), "electron-builder.yml"), "utf8")) as {
    appId: string;
    mac: { extendInfo: unknown };
  };

  it("declares extendInfo as a mapping, not a list", () => {
    const { extendInfo } = config.mac;
    expect(Array.isArray(extendInfo)).toBe(false);
    expect(typeof extendInfo).toBe("object");
  });

  it("gives every usage description a top-level key with our own text", () => {
    const extendInfo = config.mac.extendInfo as Record<string, string>;
    for (const key of [
      "NSMicrophoneUsageDescription",
      "NSDocumentsFolderUsageDescription",
      "NSDownloadsFolderUsageDescription",
    ]) {
      expect(typeof extendInfo[key]).toBe("string");
      expect(extendInfo[key]).toContain("Noise Canvas");
    }
  });

  it("uses the same app id the app registers with Windows", () => {
    const mainSource = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
    const match = mainSource.match(/setAppUserModelId\(["'`]([^"'`]+)["'`]\)/);
    expect(match?.[1]).toBe(config.appId);
  });
});
