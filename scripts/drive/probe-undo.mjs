// One quick stroke over most of a long file, then undo and redo: the store's
// magnitudes at a grid of points must come back to what they were before the
// stroke, and then to what the stroke left, value for value.
//
// Usage: node scripts/drive/probe-undo.mjs [--seconds 285] [--no-build] [--duration 500] [--log keep.log]
import { copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, closeApp, diagLines, launch, openFiles, seedEraseBrush, sleep, viewOf, writeNoise } from "./app.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SECONDS = Number(option("seconds", 285));
const DURATION = Number(option("duration", 500));

const audioDir = join(tmpdir(), "noisecanvas-noise");
const longPath = join(audioDir, `long-${SECONDS}s-${process.pid}.wav`);
copyFileSync(writeNoise(join(audioDir, `long-${SECONDS}s.wav`), SECONDS, 7), longPath);

const points = [];
for (let i = 0; i < 400; i++) points.push({ f: 0.05 + (0.9 * i) / 399, p: 0.2 + (0.6 * ((i * 37) % 100)) / 100 });

const env = build({ skip: args.includes("--no-build") });
const { app, page, profile, logPath } = await launch(env);
let failed = false;
try {
  await openFiles(app, page, [longPath]);
  await seedEraseBrush(page);
  const b = await viewOf(page);
  const id = b.id;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.down("Meta");
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 100);
  await page.keyboard.up("Meta");
  // The open's own synthesis lands first, so the stroke commits alone.
  await sleep(8000);

  const read = async () =>
    (await page.evaluate(({ id, points }) => globalThis.__readTruth(id, points), { id, points })).map((r) => r.store);
  const differing = (a, b) => a.reduce((n, value, i) => n + (Object.is(value, b[i]) ? 0 : 1), 0);
  const waitFor = async (want, label) => {
    for (let i = 0; i < 240; i++) {
      const now = await read();
      if (differing(now, want) === 0) return console.log(`${label}: every point matches`);
      await sleep(250);
    }
    const now = await read();
    failed = true;
    console.log(`${label}: ${differing(now, want)} of ${want.length} points differ`);
  };

  const before = await read();
  const y = b.y + b.height * 0.45;
  await page.mouse.move(b.x + b.width * 0.1, y);
  await page.mouse.down();
  const t0 = Date.now();
  for (;;) {
    const k = Math.min(1, (Date.now() - t0) / DURATION);
    await page.mouse.move(b.x + b.width * (0.1 + 0.8 * k), y);
    if (k >= 1) break;
    await sleep(8);
  }
  await page.mouse.up();
  const upAt = Date.now();
  while (diagLines(logPath, /commit history add/).filter((l) => l.t >= upAt).length === 0) await sleep(250);
  await sleep(500);
  const after = await read();
  const erased = differing(after, before);
  console.log(`the stroke changed ${erased} of ${points.length} points`);
  if (erased < points.length / 4) failed = true;

  const send = (channel) =>
    app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send(c), channel);
  await send("undo");
  await waitFor(before, "undo");
  await send("redo");
  await waitFor(after, "redo");
  for (const line of diagLines(logPath, /commitStroke|commit history add|navigate/).filter((l) => l.t >= upAt - 5000))
    console.log(line.line.slice(24, 220));
} finally {
  const keep = option("log", null);
  if (keep && existsSync(logPath)) copyFileSync(logPath, keep);
  await closeApp(app, profile);
}
if (failed) process.exitCode = 1;
