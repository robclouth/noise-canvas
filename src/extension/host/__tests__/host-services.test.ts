import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostServices } from "../host-services";
import { startEditorServer, type EditorServer } from "../server";
import { decodeRpcResponse, encodeRpcRequest, type BootstrapInfo, type RpcRequest } from "../../shared/rpc-protocol";

// Drives the host-services RPC the way the webview client does: encode a request
// envelope, POST /rpc, decode the response. Exercises host-services + server +
// the binary protocol against a real temp filesystem.
async function callRpc(
  origin: string,
  module: RpcRequest["module"],
  method: string,
  json: Record<string, unknown>,
  binary?: Uint8Array,
): Promise<{ json: unknown; binary: Uint8Array; ok: boolean; error?: string }> {
  const body = encodeRpcRequest({ module, method, json, hasBinary: binary !== undefined }, binary);
  const res = await fetch(`${origin}/rpc`, { method: "POST", body });
  const { response, binary: outBinary } = decodeRpcResponse(await res.arrayBuffer());
  return { json: response.json, binary: outBinary, ok: response.ok, error: response.error };
}

describe("host-services RPC", () => {
  let workDir: string;
  let userDataPath: string;
  let server: EditorServer;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "noise-canvas-rpc-"));
    userDataPath = join(workDir, "userdata");
    await fs.mkdir(userDataPath);
    const webviewDir = join(workDir, "webview");
    await fs.mkdir(webviewDir);
    await fs.writeFile(join(webviewDir, "index.html"), "<!doctype html>");
    server = await startEditorServer({ webviewDir, hostServices: createHostServices({ userDataPath }) });
  });

  afterAll(async () => {
    await server.close();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("round-trips binary writeFile/readFile", async () => {
    const path = join(workDir, "blob.bin");
    const data = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const write = await callRpc(server.origin, "fs", "writeFile", { path }, data);
    expect(write.ok).toBe(true);
    const read = await callRpc(server.origin, "fs", "readFile", { path });
    expect(read.ok).toBe(true);
    expect(Array.from(read.binary)).toEqual(Array.from(data));
  });

  it("round-trips utf-8 writeFile/readFile", async () => {
    const path = join(workDir, "note.txt");
    await callRpc(server.origin, "fs", "writeFile", { path, text: "héllo ☃", encoding: "utf-8" });
    const read = await callRpc(server.origin, "fs", "readFile", { path, encoding: "utf-8" });
    expect(read.json).toBe("héllo ☃");
  });

  it("lists directory entries plain and with file types", async () => {
    const dir = join(workDir, "sub");
    await callRpc(server.origin, "fs", "mkdir", { path: dir, recursive: true });
    await callRpc(server.origin, "fs", "writeFile", { path: join(dir, "a.txt"), text: "a", encoding: "utf-8" });

    const plain = await callRpc(server.origin, "fs", "readdir", { path: dir });
    expect(plain.json).toEqual(["a.txt"]);

    const typed = await callRpc(server.origin, "fs", "readdir", { path: dir, withFileTypes: true });
    expect(typed.json).toEqual([{ name: "a.txt", isDirectory: false, isFile: true }]);
  });

  it("stats a file and reports size", async () => {
    const path = join(workDir, "size.bin");
    await callRpc(server.origin, "fs", "writeFile", { path }, new Uint8Array(64));
    const stat = await callRpc(server.origin, "fs", "stat", { path });
    expect(stat.json).toEqual({ size: 64, isDirectory: false, isFile: true });
  });

  it("rm removes a file and access then fails", async () => {
    const path = join(workDir, "gone.txt");
    await callRpc(server.origin, "fs", "writeFile", { path, text: "x", encoding: "utf-8" });
    expect((await callRpc(server.origin, "fs", "access", { path })).ok).toBe(true);
    await callRpc(server.origin, "fs", "rm", { path });
    const access = await callRpc(server.origin, "fs", "access", { path });
    expect(access.ok).toBe(false);
    expect(access.error).toMatch(/ENOENT|no such file/i);
  });

  it("round-trips zstd compress/decompress", async () => {
    const original = new Uint8Array(2048);
    for (let i = 0; i < original.length; i++) original[i] = (i * 7) % 256;
    const compressed = await callRpc(server.origin, "zlib", "zstdCompress", {}, original);
    expect(compressed.ok).toBe(true);
    expect(compressed.binary.byteLength).toBeLessThan(original.byteLength);
    const restored = await callRpc(server.origin, "zlib", "zstdDecompress", {}, compressed.binary);
    expect(Array.from(restored.binary)).toEqual(Array.from(original));
  });

  it("serves bootstrap facts and the user-data path", async () => {
    const res = await fetch(`${server.origin}/host/bootstrap`);
    const boot = (await res.json()) as BootstrapInfo;
    expect(boot.userDataPath).toBe(userDataPath);
    expect(typeof boot.homedir).toBe("string");
    expect(boot.platform).toBe(process.platform);

    const userData = await callRpc(server.origin, "dialogs", "getUserDataPath", {});
    expect(userData.json).toBe(userDataPath);
  });
});
