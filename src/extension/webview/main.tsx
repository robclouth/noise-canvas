import { Buffer } from "buffer";
import { loadBootstrap } from "@renderer/lib/host/extension-rpc";

// The renderer core uses Node's Buffer directly (e.g. history compression), which
// a plain browser webview lacks. Polyfill it before any app module evaluates.
if (!globalThis.Buffer) globalThis.Buffer = Buffer;

// Fetch the host's synchronous facts (homedir, user-data path, platform) before
// the app mounts, so module-eval-time reads of host.os/host.env resolve, then
// dynamically import the real renderer entry (which renders the full app).
// When launched for a specific clip (?session=<id>), open its source audio so the
// editor lands on that clip rather than the empty state. The host serves the
// clip's on-disk path via the session meta; openFilePath runs analysis over RPC.
async function seedFromSession(): Promise<void> {
  const sessionId = new URLSearchParams(location.search).get("session");
  if (!sessionId) return;
  const res = await fetch(`/session/${sessionId}/meta`);
  if (!res.ok) return;
  const meta = (await res.json()) as { sourceFilePath: string };
  const { useStore } = await import("@renderer/store");
  await useStore.getState().openFilePath(meta.sourceFilePath);
}

async function start(): Promise<void> {
  try {
    await loadBootstrap();
  } catch (error) {
    console.error("Noise Canvas: host bootstrap failed", error);
  }
  await import("@renderer/main");
  try {
    await seedFromSession();
  } catch (error) {
    console.error("Noise Canvas: failed to open clip", error);
  }
}

void start();
