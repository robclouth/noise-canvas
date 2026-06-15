import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAnalyzeFramed } from "./analysis-service";
import { createHostServices } from "./host-services";
import { startEditorServer } from "./server";

// Runs the extension's editor server outside Ableton so the webview can be
// boot-debugged in a normal browser (with devtools/console), backed by the same
// localhost data plane and host-services RPC. Build with esbuild, then
// `node out-ext/dev-server.cjs`. Serves out-ext/webview on a fixed port.
async function main(): Promise<void> {
  const root = process.cwd();
  const webviewDir = join(root, "out-ext/webview");
  const userDataPath = join(homedir(), ".noise-canvas-extension-dev");

  await fs.mkdir(userDataPath, { recursive: true });

  const server = await startEditorServer({
    webviewDir,
    host: "127.0.0.1",
    port: 5174,
    analyze: runAnalyzeFramed,
    hostServices: createHostServices({ userDataPath }),
  });

  console.log(`dev server: ${server.origin}`);
  console.log(`user data:  ${userDataPath}`);
}

void main();
