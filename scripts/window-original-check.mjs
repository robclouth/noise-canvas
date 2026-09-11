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
const directory = mkdtempSync(join(tmpdir(), "nc-original-check-"));
const input = join(directory, "tone.wav");
const output = join(directory, "restored.wav");
const reference = join(directory, "reference.wav");
const frames = 60 * 44100;
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
const env = { ...process.env, VITE_CANVAS_WINDOW_BLOCKS: "8" };
delete env.ELECTRON_RUN_AS_NODE;
if (!process.argv.includes("--no-build"))
  execFileSync("npx", ["electron-vite", "build"], { cwd: root, env, stdio: "pipe" });
process.env.VITE_CANVAS_WINDOW_BLOCKS = "8";
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.closeDevTools());
  page.on("pageerror", (error) => console.error(error));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  console.log("Opened", page.url());
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 120000 });
  const noThanks = page.getByText("No thanks", { exact: false });
  if (await noThanks.count()) await noThanks.first().click();
  await page.evaluate(async () => {
    const { WindowedCanvas } = await import("/src/lib/windowed-canvas.ts");
    window.checkFiles = (await import("/src/store/files.ts")).openFiles;
    const initialize = WindowedCanvas.prototype.initialize;
    WindowedCanvas.prototype.initialize = function (...args) {
      window.checkCanvas = this;
      return initialize.apply(this, args);
    };
  });
  await app.evaluate(
    ({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send("open-file", path),
    input,
  );
  await page.waitForFunction(
    (path) => {
      const file = window.checkFiles[window.__store.getState().activeFileId];
      return file?.filePath === path && file?.rendererRef?.current?.getTextures() && window.checkCanvas?.isPopulated();
    },
    input,
    { timeout: 300000 },
  );
  const prepared = await page.evaluate(async (reference) => {
    const { openFiles, awaitFileSynthesis } = await import("/src/store/files.ts");
    const { getHistoryManager } = await import("/src/lib/history-manager.ts");
    const { serializeFileTask } = await import("/src/lib/file-task-queue.ts");
    const { blockGrid, blockPixelRanges } = await import("/src/lib/block-grid.ts");
    const file = openFiles[window.__store.getState().activeFileId];
    const history = getHistoryManager(file.id);
    await history.initialize();
    await awaitFileSynthesis(file.id);
    await window.__store.getState().synthesizeFile(file.id);
    window.rootAudio = Array.from({ length: file.audioBuffer.numberOfChannels }, (_, ch) =>
      file.audioBuffer.getChannelData(ch).slice(),
    );
    const { host } = await import("/src/lib/host/index.ts");
    await host.analysis.exportAudio(window.rootAudio, reference, file.audioBuffer.sampleRate, "wav");
    const grid = blockGrid(file.spectrogramData, file.spectrogramData.numFrames, file.spectrogramData.sampleRate);
    const canvas = window.checkCanvas;
    const reader = file.rendererRef.current;
    const nodes = [];
    for (const block of [1, grid.blockCount - 2]) {
      canvas.aim(block * grid.blockFrames, (block + 1) * grid.blockFrames);
      await canvas.settle();
      const ranges = blockPixelRanges(grid, block);
      const pixels = ranges.ranges.slice(0, ranges.count * 2);
      await serializeFileTask(file.id, async () => {
        const base = await history.currentRanges(pixels);
        const after = base.map((value, i) => (i % 2 === 0 ? value * 0.1 : value));
        reader.patchFBODataCompact(after, pixels);
        const result = await history.addStroke({
          label: "Quiet block",
          dimensions: history.getManifest().nodes[history.getCurrentId()].dimensions,
          dirtyRanges: pixels,
          baseFootprint: base,
          afterFootprint: after,
        });
        nodes.push(result.id);
      });
    }
    await history.awaitTierFlush();
    canvas.aim(0, grid.blockFrames);
    await canvas.settle();
    window.restoreCheck = { id: file.id, nodes, root: history.getManifest().rootId };
    return {
      blocks: grid.blockCount,
      windowBlocks: canvas.span() ? canvas.span().lastBlock - canvas.span().firstBlock + 1 : grid.blockCount,
      windowed: !canvas.wholeFile,
      current: history.getCurrentId(),
      nodes: Object.keys(history.getManifest().nodes).length,
    };
  }, reference);
  assert.equal(prepared.windowed, true);
  assert.equal(prepared.windowBlocks, 8);
  console.log("B3 prepared", prepared);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("restore-original"));
  await page.evaluate(async () => {
    const { drainFileTaskQueues } = await import("/src/lib/file-task-queue.ts");
    const { awaitFileSynthesis } = await import("/src/store/files.ts");
    await drainFileTaskQueues();
    await awaitFileSynthesis(window.restoreCheck.id);
  });
  const result = await page.evaluate(async () => {
    const { openFiles } = await import("/src/store/files.ts");
    const { getHistoryManager } = await import("/src/lib/history-manager.ts");
    const { getBlockStore } = await import("/src/lib/block-stores.ts");
    const { id, nodes } = window.restoreCheck;
    const file = openFiles[id];
    const history = getHistoryManager(id);
    const store = await getBlockStore(id);
    let mismatches = 0;
    let compared = 0;
    for (let block = 0; block < store.grid.blockCount; block++) {
      const ranges = store.blockRanges(block);
      const current = await store.readRanges(ranges);
      const original = await history.rootRanges(ranges);
      for (let i = 0; i < original.length; i++) {
        compared++;
        if (current[i] !== original[i]) mismatches++;
      }
    }
    const view = file.rendererRef.current.getCanvasView();
    const resident = await file.rendererRef.current.readPixelRanges(view.ranges);
    const pristine = await history.rootRanges(view.ranges);
    const residentMismatches = resident.filter((value, index) => value !== pristine[index]).length;
    let audioMaxError = 0;
    for (let ch = 0; ch < window.rootAudio.length; ch++) {
      const restored = file.audioBuffer.getChannelData(ch);
      for (let i = 0; i < restored.length; i++)
        audioMaxError = Math.max(audioMaxError, Math.abs(restored[i] - window.rootAudio[ch][i]));
    }
    return {
      compared,
      mismatches,
      residentMismatches,
      audioMaxError,
      currentUnchanged: history.getCurrentId() === nodes[1],
      nodes: Object.keys(history.getManifest().nodes).length,
    };
  });
  console.log("B3 restored", result);
  assert.equal(result.mismatches, 0);
  assert.equal(result.residentMismatches, 0);
  assert.equal(result.audioMaxError, 0);
  assert.equal(result.currentUnchanged, true);
  assert.equal(result.nodes, 3);
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, output);
  await page.evaluate(async () => {
    await window.__store.getState().saveActiveFileAs();
    window.__store.getState().closeFile(window.restoreCheck.id);
  });
  await app.evaluate(
    ({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send("open-file", path),
    output,
  );
  await page.waitForFunction(
    (path) => {
      const file = window.checkFiles[window.__store.getState().activeFileId];
      return file?.filePath === path && file.audioBuffer?.length === 60 * 44100;
    },
    output,
    { timeout: 300000 },
  );
  const saved = await page.evaluate(async (output) => {
    const { host } = await import("/src/lib/host/index.ts");
    const channels = await host.analysis.decodeAudio(output, 44100, window.rootAudio.length);
    let maxError = 0;
    for (let ch = 0; ch < channels.length; ch++) {
      for (let i = 0; i < channels[ch].length; i++)
        maxError = Math.max(maxError, Math.abs(channels[ch][i] - window.rootAudio[ch][i]));
    }
    return { frames: channels[0].length, maxError };
  }, output);
  assert.equal(saved.frames, frames);
  assert.equal(saved.maxError, 0);
  const fingerprints = async () =>
    page.evaluate(async () => {
      const { openFiles, awaitFileSynthesis } = await import("/src/store/files.ts");
      const { getHistoryManager } = await import("/src/lib/history-manager.ts");
      const { getBlockStore } = await import("/src/lib/block-stores.ts");
      const { serializeFileTask } = await import("/src/lib/file-task-queue.ts");
      const file = openFiles[window.__store.getState().activeFileId];
      await serializeFileTask(file.id, async () => {});
      await awaitFileSynthesis(file.id);
      const history = getHistoryManager(file.id);
      const store = await getBlockStore(file.id);
      const hashes = [];
      for (let block = 0; block < store.grid.blockCount; block++) {
        const values = await history.rootBlock(block);
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", values));
        hashes.push(
          Array.from(hash)
            .map((value) => value.toString(16).padStart(2, "0"))
            .join(""),
        );
      }
      const audio = [];
      for (let ch = 0; ch < file.audioBuffer.numberOfChannels; ch++) {
        audio.push(
          Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", file.audioBuffer.getChannelData(ch)))),
        );
      }
      return { hashes, audio };
    });
  const reopened = await fingerprints();
  await page.evaluate(() => window.__store.getState().closeFile(window.__store.getState().activeFileId));
  await app.evaluate(
    ({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send("open-file", path),
    reference,
  );
  await page.waitForFunction(
    (path) => {
      const file = window.checkFiles[window.__store.getState().activeFileId];
      return file?.filePath === path && file.audioBuffer?.length === 60 * 44100;
    },
    reference,
    { timeout: 300000 },
  );
  const expected = await fingerprints();
  assert.deepEqual(reopened, expected);
  console.log("B3 saved and reopened", {
    ...saved,
    matchingCoefficientBlocks: reopened.hashes.length,
    matchingAudioChannels: reopened.audio.length,
  });
} finally {
  await app.close();
  await server.close();
}
