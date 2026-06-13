import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { zstdCompress, zstdDecompress } from "node:zlib";
import type { BootstrapInfo, RpcRequest } from "../shared/rpc-protocol";

// Node-side handlers for the host-services RPC: the webview-hosted renderer core
// reaches real fs / os / zlib / per-user-data running in Live's embedded Node.
// Mirrors the narrow HostFs / HostOs / HostZlib surface the renderer uses.

const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);

export interface HostServicesConfig {
  // Directory where the extension persists per-user data (history, presets).
  userDataPath: string;
}

export interface RpcResult {
  json?: unknown;
  binary?: Uint8Array;
}

function asString(value: unknown, name: string): string {
  if (typeof value === "string") return value;
  throw new Error(`rpc: expected string for ${name}`);
}
function asBool(value: unknown): boolean {
  return value === true;
}

export interface HostServices {
  dispatch(request: RpcRequest, binary: Uint8Array): Promise<RpcResult>;
  bootstrap(): BootstrapInfo;
}

export function createHostServices(config: HostServicesConfig): HostServices {
  async function dispatchFs(method: string, json: Record<string, unknown>, binary: Uint8Array): Promise<RpcResult> {
    const path = asString(json.path, "path");
    switch (method) {
      case "readFile": {
        if (typeof json.encoding === "string") return { json: await fs.readFile(path, "utf-8") };
        return { binary: new Uint8Array(await fs.readFile(path)) };
      }
      case "writeFile": {
        const data = typeof json.text === "string" ? json.text : Buffer.from(binary);
        await fs.writeFile(path, data);
        return {};
      }
      case "readdir": {
        if (asBool(json.withFileTypes)) {
          const entries = await fs.readdir(path, { withFileTypes: true });
          return {
            json: entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })),
          };
        }
        return { json: await fs.readdir(path) };
      }
      case "mkdir": {
        const made = await fs.mkdir(path, { recursive: true });
        return { json: made ?? null };
      }
      case "rm":
        await fs.rm(path, { recursive: asBool(json.recursive), force: asBool(json.force) });
        return {};
      case "unlink":
        await fs.unlink(path);
        return {};
      case "stat": {
        const s = await fs.stat(path);
        return { json: { size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile() } };
      }
      case "access":
        await fs.access(path);
        return {};
      default:
        throw new Error(`rpc: unknown fs method ${method}`);
    }
  }

  async function dispatchZlib(method: string, binary: Uint8Array): Promise<RpcResult> {
    const input = Buffer.from(binary);
    if (method === "zstdCompress") return { binary: new Uint8Array(await zstdCompressAsync(input)) };
    if (method === "zstdDecompress") return { binary: new Uint8Array(await zstdDecompressAsync(input)) };
    throw new Error(`rpc: unknown zlib method ${method}`);
  }

  function dispatchDialogs(method: string): RpcResult {
    if (method === "getUserDataPath") return { json: config.userDataPath };
    // Native file pickers have no embedded-host equivalent yet; report cancelled
    // so callers fall back gracefully. Implemented in a later slice.
    if (method === "showSaveDialog") return { json: { canceled: true } };
    if (method === "showDirectoryDialog") return { json: { canceled: true, filePaths: [] } };
    throw new Error(`rpc: unknown dialogs method ${method}`);
  }

  return {
    async dispatch(request, binary) {
      switch (request.module) {
        case "fs":
          return dispatchFs(request.method, request.json, binary);
        case "os":
          if (request.method === "homedir") return { json: homedir() };
          throw new Error(`rpc: unknown os method ${request.method}`);
        case "zlib":
          return dispatchZlib(request.method, binary);
        case "dialogs":
          return dispatchDialogs(request.method);
        default:
          throw new Error(`rpc: unknown module ${request.module}`);
      }
    },
    bootstrap() {
      return {
        homedir: homedir(),
        userDataPath: config.userDataPath,
        platform: process.platform,
        resourcesPath: config.userDataPath,
        cwd: process.cwd(),
      };
    },
  };
}
