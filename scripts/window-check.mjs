// Checks that a canvas holding a window of the file paints what a canvas
// holding all of it paints.
//
// The unit suite cannot see this class of fault: it compares two renderers,
// and both can be fed the same empty canvas. So this drives the real app
// twice — once whole-file, once with an eight-block window — over the same
// actions, and compares the picture and the committed footprint.
//
// Usage: node scripts/window-check.mjs [blocks]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { _electron } = createRequire(join(root, "package.json"))("playwright");

const blocks = process.argv[2] ?? "8";
const SECONDS = 60;
const SAMPLE_RATE = 44100;

/** A tone long enough to need many blocks, written where the app can open it. */
function writeTone(path) {
  const frames = SECONDS * SAMPLE_RATE;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const value = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 660 * t);
    bytes.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  writeFileSync(path, bytes);
}

/** The brightest channel of each column of `rect`, read out of a screenshot. */
async function columnBrightness(app, page, rect) {
  const shot = await app.evaluate(async ({ BrowserWindow }) => {
    const picture = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return picture.toPNG().toString("base64");
  });
  return await page.evaluate(
    async ({ data, box }) =>
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onerror = () => reject(new Error("the screenshot did not decode"));
        image.onload = () => {
          const scale = image.width / window.innerWidth;
          const x = Math.round(box.x * scale);
          const y = Math.round(box.y * scale);
          const w = Math.round(box.width * scale);
          const h = Math.round(box.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, x, y, w, h, 0, 0, w, h);
          const pixels = ctx.getImageData(0, 0, w, h).data;
          const columns = [];
          for (let px = 0; px < w; px++) {
            let brightest = 0;
            for (let py = 0; py < h; py++) {
              const i = (py * w + px) * 4;
              brightest = Math.max(brightest, pixels[i], pixels[i + 1], pixels[i + 2]);
            }
            columns.push(brightest);
          }
          resolve(columns);
        };
        image.src = `data:image/png;base64,${data}`;
      }),
    { data: shot, box: rect },
  );
}

async function run(label, windowBlocks, wav) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (windowBlocks) env.VITE_CANVAS_WINDOW_BLOCKS = String(windowBlocks);
  else delete env.VITE_CANVAS_WINDOW_BLOCKS;

  process.stdout.write(`${label}: building… `);
  execFileSync("npx", ["electron-vite", "build"], { cwd: root, env, stdio: "pipe" });
  process.stdout.write("opening… ");

  const profile = mkdtempSync(join(tmpdir(), "nc-window-check-"));
  const app = await _electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root, env });
  const page = await app.firstWindow();
  const logs = [];
  const errors = [];
  page.on("console", (message) => {
    logs.push(message.text());
    if (message.type() === "error" && !/HRTF/.test(message.text())) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(4000);
  const noThanks = page.getByText("No thanks", { exact: false });
  if (await noThanks.count())
    await noThanks
      .first()
      .click()
      .catch(() => {});

  await app.evaluate(({ BrowserWindow }, path) => {
    BrowserWindow.getAllWindows()[0].webContents.send("open-file", path);
  }, wav);
  await page.waitForSelector("[data-file-view-id]", { timeout: 300000 });
  await page.waitForTimeout(20000);

  const box = await page.locator("[data-file-view-id]").first().boundingBox();
  if (!box) throw new Error("no file view to paint on");
  const strip = {
    x: box.x + box.width * 0.05,
    y: box.y + box.height * 0.2,
    width: box.width * 0.9,
    height: box.height * 0.6,
  };

  process.stdout.write("painting… ");
  // A drag across most of the file, so the window has to slide several times.
  // The frame loop paints the cursor's position once per frame, so the steps
  // are spaced wider than the slowest build's dab and both paint the same set.
  const y = box.y + box.height * 0.45;
  const from = 0.08;
  const to = 0.92;
  const steps = 24;
  await page.mouse.move(box.x + box.width * from, y);
  await page.waitForTimeout(3000);
  await page.mouse.down();
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(box.x + box.width * (from + ((to - from) * step) / steps), y);
    await page.waitForTimeout(400);
  }
  // A last dab back at the start, on a block the window has long left behind.
  // It has to wait for the read, so a window that drops a waiting dab commits
  // a shorter stroke than the whole file does.
  await page.mouse.move(box.x + box.width * 0.03, y);
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(20000);
  // Off the spectrogram, so no brush overlay lands in the picture.
  await page.mouse.move(box.x + box.width * 0.2, box.y - 40);
  await page.waitForTimeout(3000);

  const columns = await columnBrightness(app, page, strip);
  const residentMB = await page.evaluate(async () => Math.round((await process.getProcessMemoryInfo()).private / 1024));
  const footprint = logs
    .map((line) => /addStroke footprint delta.*?ranges: (\d+), footprintPixels: (\d+)/.exec(line))
    .filter(Boolean)
    .map((match) => ({ ranges: Number(match[1]), pixels: Number(match[2]) }))
    .pop();

  await app.close();
  process.stdout.write(`${residentMB} MB\n`);
  return { columns, footprint, errors, residentMB };
}

const wav = join(mkdtempSync(join(tmpdir(), "nc-window-audio-")), "tone.wav");
writeTone(wav);

const whole = await run("whole file", null, wav);
const windowed = await run(`${blocks} blocks`, blocks, wav);

const failures = [];
for (const [label, result] of [
  ["whole file", whole],
  ["windowed", windowed],
]) {
  if (!result.footprint) failures.push(`${label}: the stroke committed nothing`);
  for (const error of result.errors) failures.push(`${label} console: ${error}`);
}

if (whole.columns.length !== windowed.columns.length) {
  failures.push(`the two runs measured different widths (${whole.columns.length} vs ${windowed.columns.length})`);
} else {
  // A hole: the whole-file canvas shows content there and the windowed one is black.
  const holes = whole.columns.filter((bright, i) => bright > 60 && windowed.columns[i] < 40).length;
  if (holes > 0) failures.push(`${holes} columns of the picture went black under the window`);
}

const describe = (footprint) => (footprint ? `${footprint.ranges} ranges / ${footprint.pixels} pixels` : "—");

if (whole.footprint && windowed.footprint) {
  if (whole.footprint.ranges !== windowed.footprint.ranges) {
    failures.push(`the commit covers different bands: ${describe(whole.footprint)} vs ${describe(windowed.footprint)}`);
  }
  // The footprint's time edge rounds up to a whole bin against the band's own
  // bin count, and a band's count over the file is itself rounded up, so the
  // two runs can land a bin apart at an edge. The four-bin margin either side
  // covers it; a wider gap is real paint the commit missed.
  const slack = whole.footprint.ranges;
  const gap = Math.abs(whole.footprint.pixels - windowed.footprint.pixels);
  if (gap > slack) {
    failures.push(
      `the commit differs by ${gap} pixels: ${describe(whole.footprint)} vs ${describe(windowed.footprint)}`,
    );
  }
}

console.log(`\ncommitted   whole file: ${describe(whole.footprint)}`);
console.log(`            windowed:   ${describe(windowed.footprint)}`);
console.log(`resident    whole file: ${whole.residentMB} MB, windowed: ${windowed.residentMB} MB`);

if (failures.length > 0) {
  console.error(`\nFAILED\n${failures.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}
console.log("\nOK — the window paints what the whole file paints.");
