// Splits a long file into harmonic and percussive in place: the file must stay
// one file, holding the harmonic part, with the percussive part as its second
// layer, and the two must add back up to the original at every point. Undo
// must put the original back as a single layer; redo must bring both parts back.
//
// Usage: node scripts/drive/probe-split.mjs [--seconds 285] [--window-blocks n] [--no-build] [--log keep.log]
import { copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, closeApp, launch, openFiles, sleep, viewOf, writeNoise } from "./app.mjs";

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

const windowBlocks = option("window-blocks", undefined);
const env = build({ skip: args.includes("--no-build"), windowBlocks });
const { app, page, profile, logPath } = await launch(env);
let failed = false;
const fail = (message) => {
  failed = true;
  console.log(`FAIL ${message}`);
};

try {
  await openFiles(app, page, [longPath]);
  const owner = (await viewOf(page)).id;

  const state = () =>
    page.evaluate((owner) => {
      const s = globalThis.__store.getState();
      const stackId = s.stackOfLayer[owner];
      return {
        open: s.openFileIds,
        detached: Object.keys(s.detachedLayers),
        names: s.layerNames,
        stackOwner: stackId ? (s.layerStacks[stackId]?.ownerId ?? null) : null,
        busy: Object.keys({ ...s.filesBusy, ...s.filesLoading, ...s.filesSynthesizing }).filter(
          (id) => s.filesBusy[id] || s.filesLoading[id] || s.filesSynthesizing[id],
        ),
      };
    }, owner);
  const settle = async () => {
    await sleep(1000);
    for (let i = 0; i < 1200 && (await state()).busy.length > 0; i++) await sleep(250);
  };
  const read = async (id) =>
    (await page.evaluate(({ id, points }) => globalThis.__readTruth(id, points), { id, points })).map((r) => r.store);
  const differing = (a, b) => a.reduce((n, value, i) => n + (Object.is(value, b[i]) ? 0 : 1), 0);
  const waitFor = async (id, want, label, before) => {
    for (let i = 0; i < 240; i++) {
      const now = await read(id).catch(() => null);
      if (now && differing(now, want) === 0) return console.log(`${label}: every point matches`);
      await sleep(250);
    }
    const now = await read(id).catch(() => null);
    fail(`${label}: ${now ? differing(now, want) : "all"} of ${want.length} points differ`);
    if (!now) return;
    // Which points, and whether each still holds the state from before the step.
    const wrong = want.map((value, i) => i).filter((i) => !Object.is(now[i], want[i]));
    const pixels = await page.evaluate(({ id, points }) => globalThis.__readTruth(id, points, { history: true }), {
      id,
      points,
    });
    const fromHistory = wrong.filter((i) => Object.is(pixels[i].history, want[i])).length;
    console.log(`  the state rebuilt from history matches the wanted value at ${fromHistory} of ${wrong.length}`);
    const stale = before ? wrong.filter((i) => Object.is(now[i], before[i])).length : null;
    console.log(`  ${stale === null ? "" : `${stale} of ${wrong.length} hold the state before the step; `}first:`);
    for (const i of wrong.slice(0, 8)) {
      console.log(
        `    point ${i} f=${points[i].f.toFixed(3)} p=${points[i].p.toFixed(3)} pixel=${pixels[i].pixel} want=${want[i]} got=${now[i]} history=${pixels[i].history}${before ? ` before=${before[i]}` : ""}`,
      );
    }
  };
  const send = (channel) =>
    app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send(c), channel);

  await settle();
  const original = await read(owner);
  const originalChannels = await page.evaluate(
    ({ id, points }) => globalThis.__readTruth(id, points).then((r) => r.map((x) => x.storeChannels)),
    { id: owner, points },
  );

  const t0 = Date.now();
  await page.evaluate((id) => void globalThis.__store.getState().hpssFile(id), owner);
  for (let i = 0; i < 2400 && (await state()).open.length < 2; i++) await sleep(250);
  await settle();
  console.log(`split took ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const split = await state();
  const layer = split.open.find((id) => id !== owner);
  if (split.open.length !== 2 || !layer) fail(`expected the file and one layer, got ${split.open.length} files`);
  if (split.stackOwner !== owner) fail("the file does not own its layers");
  if (split.names[owner] !== "harmonic" || split.names[layer] !== "percussive")
    fail(`tab names are ${JSON.stringify(split.names)}`);
  const harmonic = await read(owner);
  const percussive = await read(layer);
  if (differing(harmonic, original) < points.length / 2) fail("the file still holds the original");
  const channels = (id) =>
    page.evaluate(({ id, points }) => globalThis.__readTruth(id, points).then((r) => r.map((x) => x.storeChannels)), {
      id,
      points,
    });
  const [o, h, p] = [await channels(owner), await channels(layer), originalChannels];
  let worst = 0;
  for (let i = 0; i < points.length; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const scale = Math.max(Math.abs(p[i][ch]), 1e-6);
      worst = Math.max(worst, Math.abs(o[i][ch] + h[i][ch] - p[i][ch]) / scale);
    }
  }
  if (worst > 1e-3) fail(`the parts do not add up: worst relative error ${worst}`);
  else console.log(`the parts add up to the original (worst relative error ${worst.toExponential(2)})`);

  await send("undo");
  for (let i = 0; i < 400 && (await state()).open.includes(layer); i++) await sleep(100);
  const undone = await state();
  if (undone.open.includes(layer) || !undone.detached.includes(layer)) fail("undo did not take the layer away");
  await waitFor(owner, original, "undo, the file", harmonic);

  await send("redo");
  for (let i = 0; i < 1200 && !(await state()).open.includes(layer); i++) await sleep(100);
  await settle();
  await waitFor(owner, harmonic, "redo, the harmonic part");
  await waitFor(layer, percussive, "redo, the percussive part");
  for (let i = 0; i < 100 && (await state()).names[owner] !== "harmonic"; i++) await sleep(100);
  const redone = await state();
  if (redone.names[owner] !== "harmonic") fail(`after redo the tab names are ${JSON.stringify(redone.names)}`);

  console.log("merge:");
  const stackId = await page.evaluate((id) => globalThis.__store.getState().stackOfLayer[id], owner);
  const m0 = Date.now();
  await page.evaluate((id) => void globalThis.__store.getState().mergeLayerStack(id), stackId);
  for (let i = 0; i < 2400 && (await state()).open.includes(layer); i++) await sleep(250);
  await settle();
  console.log(`merge took ${((Date.now() - m0) / 1000).toFixed(1)} s`);
  const merged = await state();
  if (merged.open.length !== 1 || !merged.detached.includes(layer)) fail("the merge did not leave one file");
  const sum = await page.evaluate(
    ({ id, points }) => globalThis.__readTruth(id, points).then((r) => r.map((x) => x.storeChannels)),
    { id: owner, points },
  );
  let worstMerge = 0;
  for (let i = 0; i < points.length; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const scale = Math.max(Math.abs(originalChannels[i][ch]), 1e-6);
      worstMerge = Math.max(worstMerge, Math.abs(Math.abs(sum[i][ch]) - Math.abs(originalChannels[i][ch])) / scale);
    }
  }
  if (worstMerge > 1e-3) fail(`the merge is not the original: worst relative error ${worstMerge}`);
  else console.log(`the merge is the original (worst relative error ${worstMerge.toExponential(2)})`);
  const mergedValues = await read(owner);

  await send("undo");
  for (let i = 0; i < 1200 && !(await state()).open.includes(layer); i++) await sleep(100);
  await settle();
  await waitFor(owner, harmonic, "undo the merge, the harmonic part", mergedValues);
  await waitFor(layer, percussive, "undo the merge, the percussive part");
  await send("redo");
  for (let i = 0; i < 400 && (await state()).open.includes(layer); i++) await sleep(100);
  await settle();
  await waitFor(owner, mergedValues, "redo the merge");
} finally {
  const keep = option("log", null);
  if (keep && existsSync(logPath)) copyFileSync(logPath, keep);
  await closeApp(app, profile);
}
if (failed) process.exitCode = 1;
