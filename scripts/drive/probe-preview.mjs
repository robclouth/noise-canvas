// Checks the low-resolution picture of edits the canvas window cannot show on a
// long file: a full-length brush turning the gain down must darken its row
// across the whole view while it only hovers, and a dab of it must darken the
// view at once, long before its commit lands.
//
// Usage: node scripts/drive/probe-preview.mjs [--seconds 285] [--no-build]
import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, closeApp, diagLines, grab, launch, openFiles, sleep, viewOf, writeNoise } from "./app.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SECONDS = Number(option("seconds", 285));

const audioDir = join(tmpdir(), "noisecanvas-noise");
const longPath = join(audioDir, `long-${SECONDS}s-${process.pid}.wav`);
copyFileSync(writeNoise(join(audioDir, `long-${SECONDS}s.wav`), SECONDS, 7), longPath);

const env = build({ skip: args.includes("--no-build") });
const { app, page, profile, logPath, console: consoleLines } = await launch(env);
const failures = [];
try {
  await openFiles(app, page, [longPath]);
  const id = await page.evaluate(() => globalThis.__store.getState().openFileIds[0]);
  await page.evaluate(async (id) => await globalThis.__store.getState().setActiveFileId(id), id);
  const b = await viewOf(page, id);
  const rect = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  const tenths = (line) =>
    Array.from({ length: 10 }, (_, i) => {
      const part = line.slice(Math.floor((i * line.length) / 10), Math.floor(((i + 1) * line.length) / 10));
      return Math.round(part.reduce((sum, value) => sum + value, 0) / part.length);
    }).join(" ");
  const setBrush = async (gainDb) =>
    await page.evaluate((gainDb) => {
      const state = globalThis.__store.getState();
      state.setParameter("brushSizeTime", 32);
      state.setParameter("effects", [
        { id: "probe-gain", effect: "dynamics", enabled: true, params: { dynamicsGainDb: gainDb } },
      ]);
    }, gainDb);
  // The mean brightness of the brush's row, as the view shows it with the cursor over it.
  const row = async () => {
    await page.mouse.move(rect.x + rect.width / 2 + 3, rect.y + rect.height / 2);
    await sleep(150);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await sleep(800);
    const {
      rows: [line],
    } = await grab(app, rect, [0.5]);
    console.log(`  tenths: ${tenths(line)}`);
    return line.reduce((sum, value) => sum + value, 0) / line.length;
  };
  await sleep(3000);

  await setBrush(0);
  const plain = await row();
  await setBrush(-30);
  const previewed = await row();
  console.log(`hover: row brightness ${plain.toFixed(1)} at 0 dB, ${previewed.toFixed(1)} at -30 dB`);
  if (!(previewed < plain - 10)) failures.push("the full-length brush did not darken its row while it hovered");

  const commits = () => diagLines(logPath, /commit history add/).length;
  const before = commits();
  await page.mouse.down();
  await sleep(40);
  await page.mouse.up();
  const upAt = performance.now();
  await page.mouse.move(rect.x + 5, rect.y + 5);
  let darkAt = null;
  for (let i = 0; i < 100 && darkAt === null; i++) {
    const {
      rows: [line],
    } = await grab(app, rect, [0.5]);
    const mean = line.reduce((sum, value) => sum + value, 0) / line.length;
    if (mean < plain - 10) {
      darkAt = performance.now() - upAt;
      console.log(`  tenths just after pen up: ${tenths(line)}`);
    } else await sleep(50);
  }
  for (let i = 0; i < 480 && commits() <= before; i++) await sleep(250);
  const committedAt = performance.now() - upAt;
  console.log(
    `stroke: the view darkened ${darkAt === null ? "never" : `${Math.round(darkAt)} ms`} after pen up; commit landed after ${Math.round(committedAt)} ms`,
  );
  if (darkAt === null) failures.push("the stroke never showed");
  else if (darkAt > committedAt / 2) failures.push("the stroke showed only as its commit landed");
  await sleep(1500);
  const {
    rows: [after],
  } = await grab(app, rect, [0.5]);
  const settled = after.reduce((sum, value) => sum + value, 0) / after.length;
  console.log(`after the commit: row brightness ${settled.toFixed(1)}`);
  if (!(settled < plain - 10)) failures.push("the committed stroke is not in the picture");
  for (const c of consoleLines)
    if (c.type === "error" && !/HRTF|valid audio stream/.test(c.text))
      failures.push(`console: ${c.text.slice(0, 200)}`);
} finally {
  await closeApp(app, profile);
}
console.log(failures.length ? `FAILED\n  ${failures.join("\n  ")}` : "OK");
process.exit(failures.length ? 1 : 0);
