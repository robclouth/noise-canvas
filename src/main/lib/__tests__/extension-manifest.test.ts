import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * The version Live shows for the extension comes from the manifest the build
 * writes. Pinned in the source manifest, it stayed at 0.1.0 through every
 * release — so the source manifest carries no version and the build stamps the
 * app's own.
 */
describe("extension manifest version", () => {
  const root = process.cwd();

  it("does not pin a version in the source manifest", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/extension/manifest.json"), "utf8"));
    expect(manifest.version).toBeUndefined();
    expect(manifest.entry).toBe("host/main.cjs");
  });

  it("stamps the app's version into the manifest it emits", () => {
    const build = readFileSync(join(root, "src/extension/host/build.mjs"), "utf8");
    expect(build).toContain('JSON.parse(await readFile(join(root, "package.json"), "utf8")).version');
    expect(build).toContain("manifest.version = appVersion");
  });
});
