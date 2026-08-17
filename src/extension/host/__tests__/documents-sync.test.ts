import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedTwinPath } from "../documents-sync";
import { copyIfExists, mergeNewer, removeIfExists, syncTrees } from "../sync-ops";

// Far enough apart that the 1 s mtime tolerance cannot blur them.
const OLD_TIME = new Date("2026-01-01T00:00:00Z");
const NEW_TIME = new Date("2026-06-01T00:00:00Z");

async function writeAt(path: string, contents: string, mtime: Date): Promise<void> {
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, contents);
  await fs.utimes(path, mtime, mtime);
}

describe("sync-ops", () => {
  let rootA: string;
  let rootB: string;

  beforeEach(async () => {
    rootA = await fs.mkdtemp(join(tmpdir(), "noise-canvas-sync-a-"));
    rootB = await fs.mkdtemp(join(tmpdir(), "noise-canvas-sync-b-"));
  });

  afterEach(async () => {
    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
  });

  it("copies files the destination lacks, recursively", async () => {
    await writeAt(join(rootA, "Effects", "brush.json"), "brush", OLD_TIME);
    mergeNewer(rootA, rootB);
    expect(await fs.readFile(join(rootB, "Effects", "brush.json"), "utf-8")).toBe("brush");
  });

  it("overwrites older destination files and keeps newer ones", async () => {
    await writeAt(join(rootA, "newer.json"), "from-a", NEW_TIME);
    await writeAt(join(rootB, "newer.json"), "stale", OLD_TIME);
    await writeAt(join(rootA, "older.json"), "stale", OLD_TIME);
    await writeAt(join(rootB, "older.json"), "from-b", NEW_TIME);

    mergeNewer(rootA, rootB);

    expect(await fs.readFile(join(rootB, "newer.json"), "utf-8")).toBe("from-a");
    expect(await fs.readFile(join(rootB, "older.json"), "utf-8")).toBe("from-b");
  });

  it("preserves the source mtime so newer-wins stays transitive", async () => {
    await writeAt(join(rootA, "a.json"), "x", NEW_TIME);
    mergeNewer(rootA, rootB);
    const copied = await fs.stat(join(rootB, "a.json"));
    expect(Math.abs(copied.mtimeMs - NEW_TIME.getTime())).toBeLessThan(1000);
  });

  it("treats a missing source directory as a no-op", async () => {
    await fs.rm(rootA, { recursive: true, force: true });
    expect(() => mergeNewer(rootA, rootB)).not.toThrow();
  });

  it("merges the named subdirs in both directions", async () => {
    await writeAt(join(rootA, "Presets", "only-a.json"), "a", OLD_TIME);
    await writeAt(join(rootB, "Palettes", "only-b.json"), "b", OLD_TIME);

    syncTrees(rootA, rootB, ["Presets", "Palettes"]);

    expect(await fs.readFile(join(rootB, "Presets", "only-a.json"), "utf-8")).toBe("a");
    expect(await fs.readFile(join(rootA, "Palettes", "only-b.json"), "utf-8")).toBe("b");
  });

  it("copyIfExists copies through missing parents and skips a missing source", async () => {
    await writeAt(join(rootA, "clip.asd"), "warp", OLD_TIME);
    copyIfExists(join(rootA, "clip.asd"), join(rootB, "deep", "nested", "clip.asd"));
    expect(await fs.readFile(join(rootB, "deep", "nested", "clip.asd"), "utf-8")).toBe("warp");

    expect(() => copyIfExists(join(rootA, "absent.asd"), join(rootB, "absent.asd"))).not.toThrow();
  });

  it("removeIfExists removes files and trees, and tolerates absence", async () => {
    await writeAt(join(rootA, "gone", "x.json"), "x", OLD_TIME);
    removeIfExists(join(rootA, "gone"));
    await expect(fs.access(join(rootA, "gone"))).rejects.toThrow();

    expect(() => removeIfExists(join(rootA, "never-existed"))).not.toThrow();
  });
});

describe("sharedTwinPath", () => {
  const storage = `${sep}storage`;
  const docs = `${sep}docs`;

  it("maps paths inside the shared subdirs onto the Documents tree", () => {
    expect(sharedTwinPath(storage, join(storage, "Presets", "Effects", "a.json"), docs)).toBe(
      join(docs, "Presets", "Effects", "a.json"),
    );
    expect(sharedTwinPath(storage, join(storage, "Palettes", "p.json"), docs)).toBe(join(docs, "Palettes", "p.json"));
    expect(sharedTwinPath(storage, join(storage, "Textures", "t.png"), docs)).toBe(join(docs, "Textures", "t.png"));
  });

  it("returns null for extension-local and out-of-root paths", () => {
    expect(sharedTwinPath(storage, join(storage, "history", "f", "node.bin"), docs)).toBeNull();
    expect(sharedTwinPath(storage, join(storage, "prefs", "noise-canvas-storage.json"), docs)).toBeNull();
    expect(sharedTwinPath(storage, storage, docs)).toBeNull();
    expect(sharedTwinPath(storage, join(sep, "elsewhere", "Presets", "a.json"), docs)).toBeNull();
  });
});
