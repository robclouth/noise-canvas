// One quick stroke on a long file, then the store read at a grid of points in
// every dab: which dabs reached the store, and which parts of each.
//
// Usage: node scripts/drive/probe-stroke.mjs [--seconds 285] [--extra 8] [--no-build]
//        [--power 0] [--strokes 1] [--settle 15000] [--before 1500] [--duration 500]
import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, launch, openFiles, seedEraseBrush, sleep, viewOf, writeNoise } from "./app.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SECONDS = Number(option("seconds", 285));
const EXTRA = Number(option("extra", 8));
const POWER = Number(option("power", 0));
const STROKES = Number(option("strokes", 1));
const SETTLE = Number(option("settle", 15000));
const DURATION = Number(option("duration", 500));
const BEFORE = Number(option("before", 1500));

const audioDir = join(tmpdir(), "noisecanvas-noise");
const extras = [2.8, 7.1, 10.9, 13.7, 13.7, 13.7, 21.5, 13.7]
  .slice(0, EXTRA)
  .map((s, i) => writeNoise(join(audioDir, `short-${i}-${s}s.wav`), s, 100 + i));
const longPath = join(audioDir, `long-${SECONDS}s-${process.pid}.wav`);
copyFileSync(writeNoise(join(audioDir, `long-${SECONDS}s.wav`), SECONDS, 7), longPath);

const env = build({ skip: args.includes("--no-build") });
const { app, page, logPath, console: consoleLines } = await launch(env);
try {
  await openFiles(app, page, [...extras, longPath]);
  await seedEraseBrush(page);
  const view = await viewOf(page);
  const id = view.id;
  await page.evaluate(() => {
    globalThis.__dabLog = [];
  });
  const b = await viewOf(page, id);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.down("Meta");
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 100);
  if (POWER > 0) for (let i = 0; i < Math.round(POWER * 5); i++) await page.mouse.wheel(0, -20);
  await page.keyboard.up("Meta");
  await sleep(BEFORE);

  const strokeLog = [];
  for (let s = 0; s < STROKES; s++) {
    const y = b.y + b.height * (0.35 + 0.1 * s);
    const from = s % 2 ? 0.9 : 0.1;
    const to = s % 2 ? 0.1 : 0.9;
    await page.mouse.move(b.x + b.width * from, y);
    await page.evaluate(() => {
      const probe = { gaps: [], last: performance.now(), on: true };
      globalThis.__gapProbe = probe;
      const tick = (now) => {
        probe.gaps.push(Math.round(now - probe.last));
        probe.last = now;
        if (probe.on) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.mouse.down();
    const t0 = Date.now();
    const moves = [];
    for (;;) {
      const k = Math.min(1, (Date.now() - t0) / DURATION);
      const sent = Date.now();
      moves.push(page.mouse.move(b.x + b.width * (from + (to - from) * k), y).then(() => Date.now() - sent));
      if (k >= 1) break;
      await sleep(8);
    }
    const acks = await Promise.all(moves);
    await page.mouse.up();
    strokeLog.push(Date.now());
    const gaps = await page.evaluate(() => {
      globalThis.__gapProbe.on = false;
      return globalThis.__gapProbe.gaps;
    });
    console.log(
      `stroke ${s}: ${moves.length} moves sent over ${Date.now() - t0} ms, ack ms ${JSON.stringify(acks.slice(0, 60))}`,
    );
    console.log(`frame gaps ms ${JSON.stringify(gaps)}`);
    await sleep(200);
  }
  await page.mouse.move(b.x + b.width * 0.99, b.y + b.height * 0.99);
  await sleep(SETTLE);

  const dabs = await page.evaluate((id) => globalThis.__dabLog.filter((d) => d.fileId === id), id);
  const grid = [0.1, 0.3, 0.5, 0.7, 0.9];
  const points = [];
  for (const d of dabs)
    for (const gx of grid) for (const gy of grid) points.push({ f: d.x + d.width * gx, p: d.y + d.height * gy });
  const readings = await page.evaluate(async ({ id, points }) => await globalThis.__readTruth(id, points), {
    id,
    points,
  });
  let k = 0;
  let lostDabs = 0;
  let partDabs = 0;
  const lines = [];
  for (const [i, d] of dabs.entries()) {
    let erased = 0;
    let canvasErased = 0;
    const cells = [];
    for (let n = 0; n < grid.length * grid.length; n++) {
      const r = readings[k++];
      const e = r.original > 0 && r.store / r.original < 0.01;
      const c = r.canvas !== null && r.original > 0 && r.canvas / r.original < 0.01;
      erased += e;
      canvasErased += c;
      cells.push(e ? "#" : c ? "c" : ".");
    }
    if (erased === 0) lostDabs++;
    else if (erased < grid.length * grid.length) partDabs++;
    lines.push(
      `dab ${String(i).padStart(3)} x=${d.x.toFixed(5)} w=${d.width.toFixed(5)} y=${d.y.toFixed(3)} h=${d.height.toFixed(3)} wait=${d.paintedAt - d.requestedAt} store=${erased}/25 canvas=${canvasErased}/25 ${cells.join("")}`,
    );
  }
  console.log(lines.join("\n"));
  const t0 = dabs[0]?.requestedAt ?? 0;
  console.log(`stroke ends at ${strokeLog.map((t) => t - t0).join(", ")} ms`);
  const { diagLines } = await import("./app.mjs");
  for (const l of diagLines(logPath, /commit state read|commitStroke|commit history add|held paint/))
    if (l.t >= t0 - 1000) console.log(`${l.t - t0} ms  ${l.line.slice(24, 200)}`);
  console.log(dabs.map((d) => `${d.requestedAt - t0}:${d.paintedAt - d.requestedAt}`).join(" "));
  for (const c of consoleLines)
    if (c.t >= t0 - 1000 && /error|warn|pageerror/.test(c.type))
      console.log(`console ${c.type} ${c.t - t0} ms: ${c.text.slice(0, 400)}`);
  for (const l of diagLines(logPath, /WARN|ERROR/))
    if (l.t >= t0 - 1000) console.log(`diag ${l.t - t0} ms: ${l.line.slice(24, 400)}`);
  console.log(`\n${dabs.length} dabs: ${lostDabs} not in the store at all, ${partDabs} partly`);
} finally {
  await app.close().catch(() => {});
}
