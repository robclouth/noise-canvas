// Opens a large binary through File → Open Raw… as a person does: the
// dialog's defaults, then Open. The result must open as a file of the length
// the dialog promised, peak at or under the ceiling, and take a quick stroke
// and an undo.
//
// Usage: node scripts/drive/probe-raw.mjs [--file <path>] [--no-build] [--log keep.log]
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build, closeApp, diagLines, launch, root, savePng, seedEraseBrush, sleep, viewOf } from "./app.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const FILE = option(
  "file",
  join(
    root,
    "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  ),
);
const shots = option("shots", null);

const env = build({ skip: args.includes("--no-build") });
const { app, page, profile, logPath, console: messages } = await launch(env);
let failed = false;
const fail = (message) => {
  failed = true;
  console.log(`FAIL ${message}`);
};

/** Opens FILE through the menu's event and the dialog with `settings`, and returns the new file's id. */
async function openRaw(mode, settings) {
  const before = await page.locator("[data-file-view-id]").count();
  await app.evaluate(
    ({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send("open-raw-file", p),
    FILE,
  );
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.evaluate((settings) => {
    const store = globalThis.__store.getState();
    for (const [key, value] of Object.entries(settings)) store.setParameter(key, value);
  }, settings);
  await sleep(300);
  if (shots) await savePng(app, `${shots}-dialog-${mode}.png`);
  const readout = await dialog.getByText(/Makes|Set /).textContent();
  console.log(`${mode}: dialog says "${readout}"`);
  const t0 = Date.now();
  await dialog.getByRole("button", { name: "Open" }).click();
  try {
    await page.waitForFunction((n) => document.querySelectorAll("[data-file-view-id]").length > n, before, {
      timeout: 120000,
    });
  } catch (error) {
    const notices = await page.locator(".mantine-Notification-root").allTextContents();
    const lines = diagLines(logPath, /./).filter((l) => l.t >= t0);
    console.log(`${mode}: no new view; notices on screen: ${JSON.stringify(notices)}`);
    for (const l of lines.slice(-15)) console.log(`  log: ${l.line.slice(0, 220)}`);
    throw error;
  }
  const opened = diagLines(logPath, /open raw/).filter((l) => l.t >= t0 - 1000);
  console.log(
    `${mode}: view mounted after ${((Date.now() - t0) / 1000).toFixed(1)} s; ${opened.at(-1)?.line.slice(24)}`,
  );
  const promised = Number(
    /(\d+):(\d+\.\d)/
      .exec(readout ?? "")
      ?.slice(1)
      .reduce((m, s) => m * 60 + Number(s), 0),
  );
  const view = await viewOf(page);
  let allocated;
  while (
    !(allocated = diagLines(logPath, /textures allocated/)
      .filter((l) => l.t >= t0)
      .at(-1))
  ) {
    if (Date.now() - t0 > 600000) break;
    await sleep(250);
  }
  const seconds = allocated?.data?.seconds;
  console.log(
    `${mode}: "${allocated?.data?.name}" analysed after ${((allocated?.t - t0) / 1000).toFixed(1)} s, ${seconds} s long`,
  );
  if (!(Math.abs(seconds - promised) < 0.2))
    fail(`${mode}: the dialog promised ${promised} s, the file holds ${seconds} s`);
  // A stroke during the open's own synthesis is not taken, so wait for it as a person would see the file settle.
  while (diagLines(logPath, /synthesizeFile total/).filter((l) => l.t >= (allocated?.t ?? t0)).length === 0) {
    if (Date.now() - t0 > 600000) break;
    await sleep(250);
  }
  console.log(`${mode}: audio ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return view.id;
}

/** The sample peak of the newest WAV Open Raw wrote. */
function peakOfWav() {
  const dir = join(profile, "raw-imports");
  const wavs = readdirSync(dir)
    .flatMap((id) => readdirSync(join(dir, id)).map((name) => join(dir, id, name)))
    .filter((path) => path.endsWith(".wav"));
  const bytes = readFileSync(wavs.at(-1));
  let at = 12;
  while (at + 8 <= bytes.length && bytes.toString("ascii", at, at + 4) !== "data") at += 8 + bytes.readUInt32LE(at + 4);
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset + at + 8, bytes.byteOffset + bytes.length));
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  return peak;
}

/** Share of rows across the middle of the view that are clearly lit, and that are clearly dark. */
async function bandContrast(id) {
  const view = await viewOf(page, id);
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  await sleep(1500);
  const data = await app.evaluate(
    async ({ BrowserWindow }, rect) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect);
      const { width, height } = image.getSize();
      return { width, height, bitmap: image.toBitmap().toString("base64") };
    },
    { x: Math.round(view.x), y: Math.round(view.y), width: Math.round(view.width), height: Math.round(view.height) },
  );
  const pixels = Buffer.from(data.bitmap, "base64");
  let lit = 0;
  let dark = 0;
  for (let y = 0; y < data.height; y++) {
    let sum = 0;
    for (let x = Math.floor(data.width * 0.4); x < Math.floor(data.width * 0.6); x++) {
      const at = (y * data.width + x) * 4;
      sum += (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3;
    }
    const mean = sum / Math.floor(data.width * 0.2);
    if (mean > 60) lit++;
    else if (mean < 20) dark++;
  }
  return { lit: lit / data.height, dark: dark / data.height };
}

try {
  const runs = {
    plain: { rawRead: "plain", rawFormat: "u8", rawSpeed: 1, rawRemoveNoise: 0 },
    "plain+noise": { rawRead: "plain", rawFormat: "u8", rawSpeed: 1, rawRemoveNoise: 70 },
    "hold+noise": {
      rawRead: "hold",
      rawFormat: "u8",
      rawSpeed: 0.5,
      rawRemoveNoise: 70,
      rawHoldLength: 64,
      rawStereo: "pan",
    },
  };
  for (const [mode, settings] of Object.entries(runs)) {
    const id = await openRaw(mode, settings);
    const peak = peakOfWav();
    console.log(`${mode}: WAV sample peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS`);
    if (!(peak > 0.01 && peak <= 0.9)) fail(`${mode}: peak ${peak}`);
    const contrast = await bandContrast(id);
    console.log(`${mode}: ${(contrast.lit * 100).toFixed(0)}% of rows lit, ${(contrast.dark * 100).toFixed(0)}% dark`);
    if (shots) await savePng(app, `${shots}-${mode}.png`);

    await seedEraseBrush(page);
    const view = await viewOf(page, id);
    const y = view.y + view.height * 0.5;
    const t0 = Date.now();
    await page.mouse.move(view.x + view.width * 0.2, y);
    await page.mouse.down();
    for (let i = 0; i <= 20; i++) {
      await page.mouse.move(view.x + view.width * (0.2 + 0.03 * i), y + (i % 3) * 6);
      await sleep(10);
    }
    await page.mouse.up();
    while (diagLines(logPath, /commit history add/).filter((l) => l.t >= t0).length === 0) {
      if (Date.now() - t0 > 120000) {
        fail(`${mode}: the stroke never committed`);
        break;
      }
      await sleep(250);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("undo"));
    await sleep(1500);
    // Two ten-minute files fill most of the graphics budget, so close each before the next.
    await page.evaluate((id) => globalThis.__store.getState().closeFile(id), id);
    await sleep(1000);
  }
  const errors = messages.filter((m) => m.type === "pageerror" || (m.type === "error" && !/DevTools/.test(m.text)));
  for (const e of errors.slice(0, 10)) console.log(`console ${e.type}: ${e.text.slice(0, 200)}`);
  if (errors.some((e) => /Open Raw failed|pageerror/.test(e.text + e.type))) fail("errors in the console");
} finally {
  const keep = option("log", null);
  if (keep && existsSync(logPath)) copyFileSync(logPath, keep);
  await closeApp(app, profile);
}
if (failed) process.exitCode = 1;
console.log(failed ? "probe-raw: FAILED" : "probe-raw: passed");
