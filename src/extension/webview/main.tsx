import { Buffer } from "buffer";
import { loadBootstrap } from "@renderer/lib/host/extension-rpc";

// The renderer core uses Node's Buffer directly (e.g. history compression), which
// a plain browser webview lacks. Polyfill it before any app module evaluates.
if (!globalThis.Buffer) globalThis.Buffer = Buffer;

// Fetch the host's synchronous facts (homedir, user-data path, platform) before
// the app mounts, so module-eval-time reads of host.os/host.env resolve, then
// dynamically import the real renderer entry (which renders the full app).
async function start(): Promise<void> {
  try {
    await loadBootstrap();
  } catch (error) {
    console.error("Noise Canvas: host bootstrap failed", error);
  }
  await import("@renderer/main");
}

void start();
