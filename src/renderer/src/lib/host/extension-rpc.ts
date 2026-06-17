import {
  decodeRpcResponse,
  encodeRpcRequest,
  type BootstrapInfo,
  type RpcRequest,
} from "../../../../extension/shared/rpc-protocol";
import type {
  DirectoryDialogOptions,
  DirectoryDialogResult,
  HostDirent,
  HostFs,
  HostOs,
  HostStats,
  HostZlib,
  SaveDialogOptions,
  SaveDialogResult,
} from "./types";

// Webview client for the host-services RPC. The page is served by the extension's
// localhost server, so it reaches the Node host's fs/os/zlib with same-origin
// fetches. fs/zlib calls are async; the synchronous os.homedir/env facts come
// from a one-time bootstrap fetched before the app mounts.

interface RpcReply<TJson> {
  json: TJson;
  binary: Uint8Array;
}

async function rpc<TJson>(
  module: RpcRequest["module"],
  method: string,
  json: Record<string, unknown>,
  binary?: Uint8Array,
): Promise<RpcReply<TJson>> {
  const body = encodeRpcRequest({ module, method, json, hasBinary: binary !== undefined }, binary);
  const res = await fetch("/rpc", { method: "POST", body });
  if (!res.ok) throw new Error(`host RPC transport failed (${res.status})`);
  const { response, binary: outBinary } = decodeRpcResponse(await res.arrayBuffer());
  if (!response.ok) throw new Error(response.error ?? "host RPC error");
  // The wire is untyped; the host and these callers agree on each method's shape.
  return { json: response.json as TJson, binary: outBinary };
}

function readFile(path: string): Promise<Uint8Array>;
function readFile(path: string, encoding: "utf-8" | "utf8"): Promise<string>;
function readFile(path: string, options: { encoding: "utf-8" | "utf8" }): Promise<string>;
async function readFile(
  path: string,
  options?: "utf-8" | "utf8" | { encoding: "utf-8" | "utf8" },
): Promise<Uint8Array | string> {
  if (options !== undefined) {
    return (await rpc<string>("fs", "readFile", { path, encoding: "utf-8" })).json;
  }
  return (await rpc<never>("fs", "readFile", { path })).binary;
}

function readdir(path: string): Promise<string[]>;
function readdir(path: string, options: { withFileTypes: true }): Promise<HostDirent[]>;
async function readdir(path: string, options?: { withFileTypes: true }): Promise<string[] | HostDirent[]> {
  if (options?.withFileTypes) {
    const { json } = await rpc<{ name: string; isDirectory: boolean; isFile: boolean }[]>("fs", "readdir", {
      path,
      withFileTypes: true,
    });
    return json.map((entry) => ({
      name: entry.name,
      isDirectory: () => entry.isDirectory,
      isFile: () => entry.isFile,
    }));
  }
  return (await rpc<string[]>("fs", "readdir", { path })).json;
}

export const extensionFs: HostFs = {
  readFile,
  readdir,
  async writeFile(path, data, encoding) {
    if (typeof data === "string") await rpc("fs", "writeFile", { path, text: data, encoding });
    else await rpc("fs", "writeFile", { path }, data);
  },
  async mkdir(path) {
    return (await rpc<string | null>("fs", "mkdir", { path, recursive: true })).json ?? undefined;
  },
  async rm(path, options) {
    await rpc("fs", "rm", { path, recursive: options?.recursive, force: options?.force });
  },
  async unlink(path) {
    await rpc("fs", "unlink", { path });
  },
  async stat(path): Promise<HostStats> {
    const { json } = await rpc<{ size: number; isDirectory: boolean; isFile: boolean }>("fs", "stat", { path });
    return { size: json.size, isDirectory: () => json.isDirectory, isFile: () => json.isFile };
  },
  async access(path) {
    await rpc("fs", "access", { path });
  },
};

export const extensionZlib: HostZlib = {
  zstdCompress(buffer, callback) {
    rpc<never>("zlib", "zstdCompress", {}, buffer).then(
      (reply) => callback(null, reply.binary),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), new Uint8Array()),
    );
  },
  zstdDecompress(buffer, callback) {
    rpc<never>("zlib", "zstdDecompress", {}, buffer).then(
      (reply) => callback(null, reply.binary),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), new Uint8Array()),
    );
  },
};

// Bootstrap is fetched once (see main.tsx) before the app mounts so synchronous
// host facts resolve without a round-trip.
let bootstrap: BootstrapInfo | null = null;

export async function loadBootstrap(): Promise<BootstrapInfo> {
  const res = await fetch("/host/bootstrap");
  if (!res.ok) throw new Error(`host bootstrap failed (${res.status})`);
  bootstrap = (await res.json()) as BootstrapInfo;
  return bootstrap;
}

export function getBootstrap(): BootstrapInfo {
  if (!bootstrap) throw new Error("host bootstrap not loaded yet");
  return bootstrap;
}

export function getBootstrapOrNull(): BootstrapInfo | null {
  return bootstrap;
}

export const extensionOs: HostOs = {
  homedir: () => getBootstrap().homedir,
};

export async function getUserDataPath(): Promise<string> {
  return (await rpc<string>("dialogs", "getUserDataPath", {})).json;
}

export async function showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult> {
  return (await rpc<SaveDialogResult>("dialogs", "showSaveDialog", { options })).json;
}

export async function showDirectoryDialog(options?: DirectoryDialogOptions): Promise<DirectoryDialogResult> {
  return (await rpc<DirectoryDialogResult>("dialogs", "showDirectoryDialog", { options: options ?? {} })).json;
}
