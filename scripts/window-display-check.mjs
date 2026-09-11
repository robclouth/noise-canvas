import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import glsl from "vite-plugin-glsl";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { _electron } = createRequire(join(root, "package.json"))("playwright");
const directory = mkdtempSync(join(tmpdir(), "nc-display-check-"));
const input = join(directory, "tone.wav");
const frames = 300 * 44100;
const wav = Buffer.alloc(44 + frames * 2);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(44100, 24);
wav.writeUInt32LE(88200, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++)
  wav.writeInt16LE(Math.round(9000 * Math.sin((i * 2 * Math.PI * 440) / 44100)), 44 + i * 2);
writeFileSync(input, wav);
const env = { ...process.env };
delete env.VITE_CANVAS_WINDOW_BLOCKS;
delete process.env.VITE_CANVAS_WINDOW_BLOCKS;
delete env.ELECTRON_RUN_AS_NODE;
if (!process.argv.includes("--no-build"))
  execFileSync("npx", ["electron-vite", "build"], { cwd: root, env, stdio: "pipe" });

const server = await createServer({
  configFile: false,
  root: join(root, "src/renderer"),
  resolve: {
    alias: {
      "@renderer": join(root, "src/renderer/src"),
      "@": join(root, "src/renderer/src"),
      "@host-impl": join(root, "src/renderer/src/lib/host/electron.ts"),
    },
  },
  plugins: [react(), glsl({ warnDuplicatedImports: false })],
  server: { host: "127.0.0.1", port: 5198, strictPort: true },
});
await server.listen();
const app = await _electron.launch({
  args: [root, `--user-data-dir=${join(directory, "profile")}`],
  cwd: root,
  env: { ...env, ELECTRON_RENDERER_URL: "http://127.0.0.1:5198" },
});
try {
  await app.firstWindow();
  const page =
    app.windows().find((page) => !page.url().startsWith("devtools:")) ??
    (await app.waitForEvent("window", (page) => !page.url().startsWith("devtools:")));
  assert(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.closeDevTools());
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 120000 });
  const noThanks = page.getByText("No thanks", { exact: false });
  if (await noThanks.count()) await noThanks.first().click();
  await page.evaluate(async () => {
    const { WindowedCanvas } = await import("/src/lib/windowed-canvas.ts");
    window.checkFiles = (await import("/src/store/files.ts")).openFiles;
    window.checkRequests = [];
    const initialize = WindowedCanvas.prototype.initialize;
    WindowedCanvas.prototype.initialize = function (...args) {
      window.checkCanvas = this;
      return initialize.apply(this, args);
    };
    const read = WindowedCanvas.prototype.readCommittedTaps;
    WindowedCanvas.prototype.readCommittedTaps = function (...args) {
      window.checkRequests.push({ time: performance.now(), runs: args[0].length });
      return read.apply(this, args);
    };
  });
  await app.evaluate(
    ({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send("open-file", path),
    input,
  );
  await page.waitForFunction(
    (path) => {
      const file = window.checkFiles[window.__store.getState().activeFileId];
      return file?.filePath === path && window.checkCanvas?.isPopulated();
    },
    input,
    { timeout: 300000 },
  );
  console.log(
    "Natural window",
    await page.evaluate(() => {
      if (window.checkCanvas.wholeFile) throw new Error("300-second fixture did not window naturally");
      const file = window.checkFiles[window.__store.getState().activeFileId];
      return {
        seconds: file.spectrogramData.numFrames / file.spectrogramData.sampleRate,
        canvasSeconds: window.checkCanvas.windowSeconds(),
      };
    }),
  );
  const view = page.locator("[data-file-view-id]").first();
  const box = await view.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.evaluate(() => {
    const state = window.__store.getState();
    window.__store.setState({
      filesZoom: { ...state.filesZoom, [state.activeFileId]: 8 },
      filesOffset: { ...state.filesOffset, [state.activeFileId]: 0 },
    });
  });
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    window.checkRequests.length = 0;
    const state = window.__store.getState();
    window.__store.setState({ filesOffset: { ...state.filesOffset, [state.activeFileId]: 0.8 } });
  });
  await page.waitForTimeout(2200);
  const requests = await page.evaluate(() => window.checkRequests);
  assert(requests.length > 0, "a disjoint fine screen must request tiles before its rest delay ends");
  const capture = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"),
  );
  writeFileSync(join(directory, "fine-live.png"), Buffer.from(capture, "base64"));
  const pixels = await page.evaluate(async () => {
    const { createByteTarget, renderMaterialToBytes } = await import("/src/lib/snapshot-capture.ts");
    const gl = window.checkCanvas.deps.gl;
    if (!gl) throw new Error("no shared renderer");
    const file = window.checkFiles[window.__store.getState().activeFileId];
    const material = file.rendererRef.current.getDisplayMaterial();
    const target = createByteTarget(128, 128);
    const overlays = material.uniforms.drawOverlays.value;
    material.uniforms.drawOverlays.value = false;
    try {
      const bytes = await renderMaterialToBytes(gl, material, target);
      return {
        bright: bytes.filter((value, index) => index % 4 !== 3 && value > 20).length,
        tiles: material.uniforms.displayTileCount.value,
      };
    } finally {
      material.uniforms.drawOverlays.value = overlays;
      target.dispose();
    }
  });
  assert(pixels.bright > 0, "the fine live display must contain the tone");
  console.log("PASS disjoint fine view", { requests: requests.length, ...pixels, directory });
} finally {
  await app.close();
  await server.close();
}
