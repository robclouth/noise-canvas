// A file gains a layer, both layers are painted, and undo walks every step back
// across both, in order, then redo walks it forward again. At each step the
// store's values at a grid of points must match what that step left, the
// right layer must be on screen, and the added layer must be gone once its
// step is undone and back, with its paint, once it is redone.
//
// Usage: node scripts/drive/probe-layers.mjs [--seconds 285] [--no-build] [--log keep.log]
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

const audioDir = join(tmpdir(), "noisecanvas-noise");
const longPath = join(audioDir, `long-${SECONDS}s-${process.pid}.wav`);
copyFileSync(writeNoise(join(audioDir, `long-${SECONDS}s.wav`), SECONDS, 7), longPath);

const points = [];
for (let i = 0; i < 300; i++) points.push({ f: 0.05 + (0.9 * i) / 299, p: 0.15 + (0.7 * ((i * 37) % 100)) / 100 });

const env = build({ skip: args.includes("--no-build") });
let { app, page, profile, logPath } = await launch(env);
let failed = false;
const fail = (message) => {
  failed = true;
  console.log(`FAIL ${message}`);
};

try {
  await openFiles(app, page, [longPath]);
  const owner = (await viewOf(page)).id;
  await sleep(8000);

  const state = () =>
    page.evaluate(() => {
      const s = globalThis.__store.getState();
      return { active: s.activeFileId, open: s.openFileIds, detached: Object.keys(s.detachedLayers) };
    });
  const read = async (id) =>
    (await page.evaluate(({ id, points }) => globalThis.__readTruth(id, points), { id, points })).map((r) => r.store);
  const differing = (a, b) => a.reduce((n, value, i) => n + (Object.is(value, b[i]) ? 0 : 1), 0);
  const waitFor = async (id, want, label) => {
    for (let i = 0; i < 240; i++) {
      const now = await read(id).catch(() => null);
      if (now && differing(now, want) === 0) return console.log(`${label}: every point matches`);
      await sleep(250);
    }
    const now = await read(id).catch(() => null);
    fail(`${label}: ${now ? differing(now, want) : "all"} of ${want.length} points differ`);
  };
  const waitIdle = async (since) => {
    for (let i = 0; i < 480; i++) {
      if (diagLines(logPath, /commit history add/).filter((l) => l.t >= since).length > 0) return await sleep(800);
      await sleep(250);
    }
    throw new Error("the stroke never committed");
  };
  // A stroke during a file's own synthesis is refused, so each paint waits for it.
  const waitSettled = async (id) => {
    await sleep(1000);
    for (let i = 0; i < 600; i++) {
      const busy = await page.evaluate((id) => {
        const s = globalThis.__store.getState();
        return Boolean(s.filesSynthesizing[id] || s.filesLoading[id] || s.filesBusy[id]);
      }, id);
      if (!busy) return;
      await sleep(250);
    }
    throw new Error(`file ${id} never settled`);
  };
  const stroke = async (id, y0) => {
    await waitSettled(id);
    const b = await viewOf(page, id);
    const y = b.y + b.height * y0;
    const t = Date.now();
    await page.mouse.move(b.x + b.width * 0.15, y);
    await page.mouse.down();
    for (let k = 0; k <= 1; k += 0.05) {
      await page.mouse.move(b.x + b.width * (0.15 + 0.7 * k), y);
      await sleep(12);
    }
    await page.mouse.up();
    await waitIdle(t);
  };
  const send = (channel) =>
    app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send(c), channel);
  const expectActive = async (id, label) => {
    for (let i = 0; i < 40; i++) {
      if ((await state()).active === id) return;
      await sleep(100);
    }
    fail(`${label}: layer ${id} is not on screen (active ${(await state()).active})`);
  };

  // Step 1: paint the file itself.
  await seedEraseBrush(page);
  const ownerStart = await read(owner);
  await stroke(owner, 0.35);
  const ownerAfter1 = await read(owner);
  if (differing(ownerAfter1, ownerStart) < 10) fail("the first stroke changed too little");

  // Step 2: add a layer.
  await page.evaluate((id) => globalThis.__store.getState().addEmptyLayer(id), owner);
  for (let i = 0; i < 400 && (await state()).active === owner; i++) await sleep(100);
  const layer = (await state()).active;
  for (let i = 0; i < 400 && !(await viewOf(page, layer)); i++) await sleep(100);
  await sleep(3000);
  const layerStart = await read(layer);

  // Step 3: paint the layer with sound.
  await page.evaluate(() =>
    globalThis.__store
      .getState()
      .setParameter("effects", [{ id: "drive-synth", effect: "synthesize", enabled: true, params: {} }]),
  );
  await stroke(layer, 0.5);
  const layerAfter = await read(layer);
  if (differing(layerAfter, layerStart) < 10) fail("the layer stroke changed too little");

  // Step 4: back on the file's own layer, paint again.
  await page.evaluate((id) => globalThis.__store.getState().setActiveFileId(id), owner);
  await sleep(1500);
  await seedEraseBrush(page);
  await stroke(owner, 0.65);
  const ownerAfter2 = await read(owner);

  console.log("undo:");
  await send("undo");
  await waitFor(owner, ownerAfter1, "undo 1, the second file stroke");
  await expectActive(owner, "undo 1");
  await send("undo");
  await expectActive(layer, "undo 2");
  await waitFor(layer, layerStart, "undo 2, the layer stroke");
  await send("undo");
  for (let i = 0; i < 100 && (await state()).open.includes(layer); i++) await sleep(100);
  const hidden = await state();
  if (hidden.open.includes(layer) || !hidden.detached.includes(layer)) fail("undo 3 did not hide the layer");
  else console.log("undo 3, the added layer: hidden");
  await send("undo");
  await waitFor(owner, ownerStart, "undo 4, the first file stroke");

  console.log("redo:");
  await send("redo");
  await waitFor(owner, ownerAfter1, "redo 1, the first file stroke");
  await send("redo");
  for (let i = 0; i < 300 && !(await state()).open.includes(layer); i++) await sleep(100);
  if (!(await state()).open.includes(layer)) fail("redo 2 did not bring the layer back");
  await waitFor(layer, layerStart, "redo 2, the added layer");
  await send("redo");
  await expectActive(layer, "redo 3");
  await waitFor(layer, layerAfter, "redo 3, the layer stroke");
  await send("redo");
  await waitFor(owner, ownerAfter2, "redo 4, the second file stroke");

  for (const line of diagLines(logPath, /error|Error|failed/).slice(-10)) console.log(line.line.slice(24, 220));

  console.log("restart with the layer hidden:");
  await send("undo");
  await send("undo");
  await send("undo");
  for (let i = 0; i < 300 && (await state()).open.includes(layer); i++) await sleep(100);
  if ((await state()).open.includes(layer)) throw new Error("the layer did not hide before the restart");
  await sleep(2000);
  await app.close();
  ({ app, page } = await launch(env, { profile }));
  for (let i = 0; i < 1200; i++) {
    const s = await state().catch(() => null);
    if (
      s &&
      s.open.includes(owner) &&
      !(await page.evaluate((id) => globalThis.__store.getState().filesLoading[id], owner))
    )
      break;
    await sleep(250);
  }
  const reopened = await state();
  if (!reopened.detached.includes(layer)) fail("the hidden layer is not listed after the restart");
  await waitSettled(owner);
  await waitFor(owner, ownerAfter1, "after the restart, the file");
  await send("redo");
  for (let i = 0; i < 300 && !(await state()).open.includes(layer); i++) await sleep(100);
  if (!(await state()).open.includes(layer)) fail("redo after the restart did not bring the layer back");
  await waitFor(layer, layerStart, "after the restart, redo, the added layer");
  await send("redo");
  await waitFor(layer, layerAfter, "after the restart, redo, the layer stroke");
} finally {
  const keep = option("log", null);
  if (keep && existsSync(logPath)) copyFileSync(logPath, keep);
  await closeApp(app, profile);
}
if (failed) process.exitCode = 1;
