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

/**
 * The README links to https://.../releases/latest/download/<file>. GitHub
 * resolves that only when the newest release holds an asset with exactly that
 * name, so a rename here breaks every download button in the README.
 */
describe("electron-builder artifact names", () => {
  const config = load(readFileSync(join(process.cwd(), "electron-builder.yml"), "utf8")) as {
    nsis: { artifactName: string };
    dmg: { artifactName: string };
    appImage: { artifactName: string };
    deb: { artifactName: string };
  };
  const { name } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    name: string;
  };
  const templates = [config.nsis, config.dmg, config.appImage, config.deb].map((target) => target.artifactName);

  /** Expand an artifactName template the way electron-builder does. */
  const expand = (template: string, ext: string, arch = ""): string =>
    template.replace("${name}", name).replace("${arch}", arch).replace("${ext}", ext);

  const published = new Set([
    expand(config.dmg.artifactName, "dmg", "arm64"),
    expand(config.dmg.artifactName, "dmg", "x64"),
    expand(config.nsis.artifactName, "exe"),
    expand(config.appImage.artifactName, "AppImage"),
    expand(config.deb.artifactName, "deb"),
    // Packaged by scripts/package-extension.mjs, not electron-builder.
    "noise-canvas.ablx",
  ]);

  it("omits the version from every artifact name", () => {
    for (const template of templates) expect(template).not.toContain("${version}");
  });

  it("produces every file the README offers for download", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    const linked = [...readme.matchAll(/releases\/latest\/download\/([^)\s]+)/g)].map((match) => match[1]);

    expect(linked.length).toBeGreaterThan(0);
    for (const file of linked) expect([...published]).toContain(file);
  });
});
