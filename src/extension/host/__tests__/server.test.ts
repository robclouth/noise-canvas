import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEditorServer, type EditorServer } from "../server";
import type { ClipMeta } from "../session";

const META: ClipMeta = {
  sourceFilePath: "/Users/test/loop.wav",
  name: "loop",
  startTime: 4,
  isWarped: true,
};

describe("editor server round-trip", () => {
  let webviewDir: string;
  let server: EditorServer;

  beforeEach(async () => {
    webviewDir = await fs.mkdtemp(join(tmpdir(), "noise-canvas-webview-"));
    await fs.writeFile(join(webviewDir, "index.html"), "<!doctype html><title>editor</title>");
    await fs.mkdir(join(webviewDir, "assets"));
    await fs.writeFile(join(webviewDir, "assets", "app.js"), "export const x = 1;");
    server = await startEditorServer({ webviewDir });
  });

  afterEach(async () => {
    await server.close();
    await fs.rm(webviewDir, { recursive: true, force: true });
  });

  it("serves the source audio and resolves with the rendered result", async () => {
    // A multi-megabyte payload, the size class the localhost data plane exists to
    // carry (data: URLs would not).
    const source = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < source.length; i++) source[i] = i % 256;
    const session = server.sessions.create(META, source);

    const fetchedSource = new Uint8Array(
      await (await fetch(`${server.origin}/session/${session.id}/source.wav`)).arrayBuffer(),
    );
    expect(fetchedSource.byteLength).toBe(source.byteLength);
    expect(Array.from(fetchedSource.slice(0, 512))).toEqual(Array.from(source.slice(0, 512)));

    const meta = await (await fetch(`${server.origin}/session/${session.id}/meta`)).json();
    expect(meta).toEqual(META);

    const rendered = new Uint8Array(2 * 1024 * 1024).fill(7);
    const post = await fetch(`${server.origin}/session/${session.id}/result.wav`, {
      method: "POST",
      body: rendered,
    });
    expect(post.status).toBe(200);

    const result = await session.result;
    expect(result.byteLength).toBe(rendered.byteLength);
    expect(result[0]).toBe(7);
  });

  it("rejects the result promise when the edit is cancelled", async () => {
    const session = server.sessions.create(META, new Uint8Array(8));
    const rejected = expect(session.result).rejects.toThrow(/cancelled/);
    await fetch(`${server.origin}/session/${session.id}/cancel`, { method: "POST" });
    await rejected;
  });

  it("returns 404 for an unknown session", async () => {
    const res = await fetch(`${server.origin}/session/does-not-exist/meta`);
    expect(res.status).toBe(404);
  });

  it("serves the webview index and assets", async () => {
    const index = await fetch(`${server.origin}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("editor");

    const asset = await fetch(`${server.origin}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
  });

  it("refuses path traversal outside the webview directory", async () => {
    const res = await fetch(`${server.origin}/../../../../etc/passwd`);
    // Either blocked outright or normalized back into the webview root; never a
    // file from outside webviewDir.
    if (res.status === 200) {
      expect(await res.text()).toContain("editor");
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });
});
