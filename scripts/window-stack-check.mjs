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
const directory = mkdtempSync(join(tmpdir(), "nc-stack-check-"));
const input = join(directory, "tone.wav");
const frames = 20 * 44100;
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.closeDevTools());
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 120000 });
  const noThanks = page.getByText("No thanks", { exact: false });
  await noThanks.first().waitFor({ state: "visible", timeout: 30000 });
  await noThanks.first().click();
  await noThanks.first().waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    window.checkFiles = (await import("/src/store/files.ts")).openFiles;
  });
  const ids = [];
  for (const hz of [220, 880, 3520]) {
    const path = join(directory, `${hz}.wav`);
    for (let i = 0; i < frames; i++)
      wav.writeInt16LE(Math.round(9000 * Math.sin((i * 2 * Math.PI * hz) / 44100)), 44 + i * 2);
    writeFileSync(path, wav);
    await app.evaluate(
      ({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send("open-file", path),
      path,
    );
    await page.waitForFunction(
      (path) => {
        const file = window.checkFiles[window.__store.getState().activeFileId];
        return file?.filePath === path && file.rendererRef?.current?.getTextures();
      },
      path,
      { timeout: 300000 },
    );
    ids.push(await page.evaluate(() => window.__store.getState().activeFileId));
  }
  await page.evaluate((ids) => {
    const state = window.__store.getState();
    state.createLayerStack({
      id: "check-stack",
      kind: "user",
      label: "Check",
      originId: null,
      layerIds: ids,
      hue: 30,
      syncView: true,
      layout: "overlaid",
    });
    window.__store.setState({
      openFileIds: ids,
      activeFileId: ids[2],
      gridSizeBeats: 1 / 64,
      gridSizeSemis: 1,
      snapTime: false,
      snapPitch: false,
    });
  }, ids);
  const view = page.locator(`[data-file-view-id="${ids[2]}"]`);
  await page.mouse.move(10, 10);
  await page.waitForTimeout(2200);
  await page.evaluate((top) => {
    window.checkView = document.querySelector(`[data-file-view-id="${top}"]`);
    window.checkTopMaterial = window.checkFiles[top].rendererRef.current.getDisplayMaterial();
    window.checkStill = () => {
      const canvas = window.checkView.querySelector("canvas");
      if (canvas.style.visibility !== "visible") throw new Error("the pointer-away check must see the DOM still");
      return Array.from(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data);
    };
    window.checkBefore = window.checkStill();
  }, ids[2]);
  await page.evaluate((ids) => {
    window.__store.setState({ openFileIds: [ids[0], ids[2]] });
  }, ids);
  await page.waitForTimeout(2200);
  const changed = await page.evaluate(async (ids) => {
    const top = window.checkFiles[ids[2]].rendererRef.current;
    if (
      document.querySelector(`[data-file-view-id="${ids[2]}"]`) !== window.checkView ||
      top.getDisplayMaterial() !== window.checkTopMaterial
    )
      throw new Error("the top view remounted");
    const { layerTint } = await import("/src/lib/layer-tint.ts");
    for (const [index, id] of [ids[0], ids[2]].entries()) {
      const material = window.checkFiles[id].rendererRef.current.getDisplayMaterial();
      const tint = layerTint(index, 2);
      for (const channel of ["left", "right"]) {
        const actual = material.uniforms[`${channel}Tint`].value.toArray();
        if (actual.some((value, i) => Math.abs(value - tint[channel][i]) > 1e-6)) throw new Error("old layer tint");
      }
    }
    const actual = window.checkStill();
    const changed = actual.filter((value, i) => value !== window.checkBefore[i]).length;
    await top.captureSnapshot([window.checkFiles[ids[0]].rendererRef.current.getDisplayMaterial()]);
    const expected = window.checkStill();
    return { changed, mismatches: actual.filter((value, i) => Math.abs(value - expected[i]) > 1).length };
  }, ids);
  assert(changed.changed > 0, "removing a background layer must change the static still");
  assert.equal(changed.mismatches, 0, "the static still must match the current layer count and tints");
  console.log("PASS retained static removal", changed);
  await page.evaluate((top) => {
    const current = window.checkFiles[top].rendererRef.current;
    const captureSnapshot = current.captureSnapshot;
    window.checkCaptures = 0;
    window.checkGate = new Promise((resolve) => {
      window.releaseCheckCapture = resolve;
    });
    current.captureSnapshot = async (...args) => {
      window.checkCaptures++;
      const ok = await captureSnapshot(...args);
      await window.checkGate;
      return ok;
    };
    current.refreshSnapshot();
  }, ids[2]);
  await page.waitForFunction(() => window.checkCaptures > 0);
  await page.evaluate((ids) => window.__store.setState({ openFileIds: [ids[2], ids[0]] }), ids);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.releaseCheckCapture());
  await page.waitForFunction(() => window.checkCaptures >= 2, null, { timeout: 10000 });
  console.log("PASS dirty revision during capture", await page.evaluate(() => window.checkCaptures));
  await page.waitForTimeout(300);
  const pendingMismatches = await page.evaluate(async (ids) => {
    const actual = window.checkStill();
    await window.checkFiles[ids[2]].rendererRef.current.captureSnapshot([
      window.checkFiles[ids[0]].rendererRef.current.getDisplayMaterial(),
    ]);
    return window.checkStill().filter((value, i) => Math.abs(value - actual[i]) > 1).length;
  }, ids);
  assert.equal(pendingMismatches, 0, "the pending revision must capture the reordered tints");

  const box = await view.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(2200);
  const live = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"),
  );
  writeFileSync(join(directory, "stack-live.png"), Buffer.from(live, "base64"));
  await page.mouse.move(10, 10);
  await page.waitForTimeout(2200);
  const still = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"),
  );
  writeFileSync(join(directory, "stack-still.png"), Buffer.from(still, "base64"));
  const pixels = await page.evaluate(
    async ({ live, still, box }) => {
      const decode = async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const scale = image.width / innerWidth;
        return ctx.getImageData(
          Math.round((box.x + box.width * 0.1) * scale),
          Math.round((box.y + box.height * 0.1) * scale),
          Math.round(box.width * 0.25 * scale),
          Math.round(box.height * 0.8 * scale),
        ).data;
      };
      const a = await decode(live),
        b = await decode(still);
      return {
        bright: a.filter((value, i) => i % 4 !== 3 && value > 20).length,
        mismatches: a.filter((value, i) => Math.abs(value - b[i]) > 2).length,
        values: a.length,
      };
    },
    { live, still, box },
  );
  assert(pixels.bright > 0);
  assert.equal(pixels.mismatches, 0, "live pixels must match the pointer-away still outside the brush");
  console.log("PASS live pixels", { ...pixels, seconds: 20, directory });
} finally {
  await app.close();
  await server.close();
}
