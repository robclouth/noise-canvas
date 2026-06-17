// Envelope for the host-services RPC (fs / os / zlib / dialogs) the webview
// makes to the Node extension host over localhost. Most calls are small JSON,
// but a few carry one binary blob in or out (readFile/writeFile bytes, zstd
// payloads), so the envelope is a JSON header plus an optional binary section:
//
//   [u32 LE headerByteLength][header JSON utf8][binary bytes]

// Synchronous host facts the webview caches before mounting the app, so sync
// accessors (os.homedir, env.platform) resolve without an async round-trip.
export interface BootstrapInfo {
  homedir: string;
  userDataPath: string;
  platform: NodeJS.Platform;
  resourcesPath: string;
  cwd: string;
}

export interface RpcRequest {
  module: "fs" | "os" | "zlib" | "dialogs";
  method: string;
  // Non-binary arguments (paths, options, string data). Method-specific shape.
  json: Record<string, unknown>;
  // True when a binary blob follows the header (e.g. writeFile bytes).
  hasBinary: boolean;
}

export interface RpcResponse {
  ok: boolean;
  // Non-binary result (string, string[], stat fields). Method-specific shape.
  json?: unknown;
  error?: string;
  hasBinary: boolean;
}

function encode(header: object, binary?: Uint8Array): Uint8Array<ArrayBuffer> {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const bodyLength = binary ? binary.byteLength : 0;
  const out = new Uint8Array(4 + headerBytes.byteLength + bodyLength);
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength, true);
  out.set(headerBytes, 4);
  if (binary) out.set(binary, 4 + headerBytes.byteLength);
  return out;
}

function decode(buffer: ArrayBuffer): { header: unknown; binary: Uint8Array } {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)));
  const binary = new Uint8Array(buffer, 4 + headerLength);
  return { header, binary };
}

export function encodeRpcRequest(request: RpcRequest, binary?: Uint8Array): Uint8Array<ArrayBuffer> {
  return encode(request, binary);
}

export function decodeRpcRequest(buffer: ArrayBuffer): { request: RpcRequest; binary: Uint8Array } {
  const { header, binary } = decode(buffer);
  return { request: header as RpcRequest, binary };
}

export function encodeRpcResponse(response: RpcResponse, binary?: Uint8Array): Uint8Array<ArrayBuffer> {
  return encode(response, binary);
}

export function decodeRpcResponse(buffer: ArrayBuffer): { response: RpcResponse; binary: Uint8Array } {
  const { header, binary } = decode(buffer);
  return { response: header as RpcResponse, binary };
}
