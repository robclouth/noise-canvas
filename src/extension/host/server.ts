import { createReadStream, promises as fs } from "node:fs";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
// Live's embedded Node host does not expose the WHATWG URL global, so import it
// explicitly rather than relying on globalThis.URL.
import { URL } from "node:url";
import type { HostServices } from "./host-services";
import { decodeRpcRequest, encodeRpcResponse } from "../shared/rpc-protocol";
import { SessionStore } from "./session";

// data: URLs don't scale to multi-megabyte audio and Live's modal dialog is a
// single-shot result string with no live channel, so the host runs a localhost
// HTTP server as the data plane: it serves the built webview and brokers the
// source-audio-out / rendered-audio-in round-trip per session.

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wav": "audio/wav",
};

export interface EditorServer {
  readonly origin: string;
  readonly sessions: SessionStore;
  close(): Promise<void>;
}

export interface EditorServerOptions {
  // Directory of the built webview (out-ext/webview) to serve statically.
  webviewDir: string;
  // Bind host; localhost only — the data plane must never be externally reachable.
  host?: string;
  // Bind port; 0 picks an ephemeral free port (the default).
  port?: number;
  // Runs native analysis on an on-disk clip path and returns the packed
  // spectrogram as an encoded binary frame. Injected by the host so the server
  // stays decoupled from the gaborator/ffmpeg native dependencies.
  analyze?: (filePath: string, params: { bandsPerOctave: number; minFreq: number }) => Promise<Uint8Array>;
  // Synthesises audio from a painted spectrogram frame; returns a PCM frame.
  synthesize?: (request: ArrayBuffer) => Promise<Uint8Array>;
  // Node-side fs/os/zlib/dialogs the renderer core reaches over the RPC envelope.
  hostServices?: HostServices;
}

// Buffer's backing ArrayBuffer may be a shared pool slice; copy out the exact
// bytes into a fresh ArrayBuffer for the protocol decoders.
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": MIME[".json"],
    "content-length": payload.byteLength,
  });
  res.end(payload);
}

// Resolves a request path inside webviewDir, refusing any path that escapes it.
function resolveStaticPath(webviewDir: string, urlPath: string): string | null {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(webviewDir, clean === "/" || clean === "." ? "index.html" : clean);
  if (candidate !== webviewDir && !candidate.startsWith(webviewDir + sep)) return null;
  return candidate;
}

export async function startEditorServer(options: EditorServerOptions): Promise<EditorServer> {
  const sessions = new SessionStore();
  const host = options.host ?? "127.0.0.1";

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      else res.end();
    });
  });

  // GET /session/:id/source.wav        → original clip bytes
  // GET /session/:id/meta              → ClipMeta JSON
  // POST /session/:id/result.wav       → rendered WAV; resolves session.result
  // POST /session/:id/cancel           → user dismissed; rejects session.result
  // GET  /*                            → static webview asset
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const sessionMatch = url.pathname.match(/^\/session\/([^/]+)\/(source\.wav|meta|result\.wav|cancel)$/);

    if (sessionMatch) {
      const [, id, action] = sessionMatch;
      const session = sessions.get(id);
      if (!session) return sendJson(res, 404, { error: "unknown session" });

      if (action === "source.wav" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": MIME[".wav"],
          "content-length": session.sourceBytes.byteLength,
        });
        res.end(Buffer.from(session.sourceBytes));
        return;
      }
      if (action === "meta" && req.method === "GET") {
        return sendJson(res, 200, session.meta);
      }
      if (action === "result.wav" && req.method === "POST") {
        const body = await readBody(req);
        session.resolveResult(new Uint8Array(body));
        return sendJson(res, 200, { ok: true });
      }
      if (action === "cancel" && req.method === "POST") {
        session.rejectResult(new Error("edit cancelled"));
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    // Native analysis of an on-disk clip path (filePath + ffmpeg + gaborator,
    // exactly as the Electron app). Stateless, so it is not session-scoped.
    if (url.pathname === "/analyze" && req.method === "POST") {
      if (!options.analyze) return sendJson(res, 501, { error: "analysis not available" });
      const body = await readBody(req);
      const request = JSON.parse(body.toString("utf8")) as {
        filePath: string;
        bandsPerOctave: number;
        minFreq: number;
      };
      const framed = await options.analyze(request.filePath, {
        bandsPerOctave: request.bandsPerOctave,
        minFreq: request.minFreq,
      });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": framed.byteLength,
      });
      res.end(Buffer.from(framed.buffer, framed.byteOffset, framed.byteLength));
      return;
    }

    // Synthesise audio from a painted spectrogram frame (native gaborator).
    if (url.pathname === "/synthesize" && req.method === "POST") {
      if (!options.synthesize) return sendJson(res, 501, { error: "synthesis not available" });
      const framed = await options.synthesize(toArrayBuffer(await readBody(req)));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": framed.byteLength });
      res.end(Buffer.from(framed.buffer, framed.byteOffset, framed.byteLength));
      return;
    }

    // Host-services RPC (fs / os / zlib / dialogs) for the renderer core.
    if (url.pathname === "/rpc" && req.method === "POST") {
      if (!options.hostServices) return sendJson(res, 501, { error: "host services unavailable" });
      const { request, binary } = decodeRpcRequest(toArrayBuffer(await readBody(req)));
      let response: Uint8Array;
      try {
        const result = await options.hostServices.dispatch(request, binary);
        response = encodeRpcResponse({ ok: true, json: result.json, hasBinary: !!result.binary }, result.binary);
      } catch (error) {
        response = encodeRpcResponse({ ok: false, error: String(error), hasBinary: false });
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": response.byteLength });
      res.end(Buffer.from(response.buffer, response.byteOffset, response.byteLength));
      return;
    }

    // Synchronous host facts (homedir, platform, user-data path) the webview
    // caches before mounting the app, so sync accessors like os.homedir() work.
    if (url.pathname === "/host/bootstrap" && req.method === "GET") {
      if (!options.hostServices) return sendJson(res, 501, { error: "host services unavailable" });
      return sendJson(res, 200, options.hostServices.bootstrap());
    }

    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });

    const filePath = resolveStaticPath(options.webviewDir, url.pathname);
    if (!filePath) return sendJson(res, 403, { error: "forbidden" });
    let target = filePath;
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) target = join(target, "index.html");
    } catch {
      // SPA fallback: unknown non-asset paths serve index.html.
      if (extname(target)) return sendJson(res, 404, { error: "not found" });
      target = join(options.webviewDir, "index.html");
    }
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    createReadStream(target).pipe(res);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });

  const address = server.address() as AddressInfo;
  const origin = `http://${host}:${address.port}`;

  return {
    origin,
    sessions,
    close: () => new Promise<void>((resolve, reject) => server.close((err?: Error) => (err ? reject(err) : resolve()))),
  };
}

// Exported for direct typing in tests without re-deriving the Server shape.
export type { Server };
