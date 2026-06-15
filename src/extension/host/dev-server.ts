import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { runAnalyzeFramed, runSynthesizeFramed } from "./analysis-service";
import { createHostServices } from "./host-services";
import { startEditorServer } from "./server";

// Generates a short test clip so the dev server can seed a real ?session= URL.
async function makeTestClip(path: string): Promise<void> {
  const ffmpeg = ffmpegPath;
  if (!ffmpeg) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=4", "-ar", "44100", "-ac", "1", path],
      { windowsHide: true },
    );
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });
}

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
    synthesize: runSynthesizeFramed,
    hostServices: createHostServices({ userDataPath }),
  });

  const clipPath = join(tmpdir(), "noise-canvas-dev-clip.wav");
  await makeTestClip(clipPath);
  const session = server.sessions.create(
    { sourceFilePath: clipPath, name: "dev clip", startTime: 0, duration: 8, isWarped: false },
    new Uint8Array(await fs.readFile(clipPath)),
  );

  console.log(`dev server: ${server.origin}`);
  console.log(`empty:      ${server.origin}/`);
  console.log(`seeded:     ${server.origin}/?session=${session.id}`);
  console.log(`user data:  ${userDataPath}`);
}

void main();
