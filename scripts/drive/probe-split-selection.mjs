// Splits a band-limited selection of a file into harmonic and percussive in
// place. The parts must add back up to the original at every point; outside the
// selection the file must hold the original and the new layer silence. Undo must
// put the original back as a single layer; redo must bring both parts back.
//
// Usage: node scripts/drive/probe-split-selection.mjs [--seconds 60] [--window-blocks 4] [--no-build]
import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, closeApp, launch, openFiles, sleep, viewOf, writeNoise } from "./app.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SECONDS = Number(option("seconds", 60));

const audioDir = join(tmpdir(), "noisecanvas-noise");
const path = join(audioDir, `long-${SECONDS}s-${process.pid}.wav`);
copyFileSync(writeNoise(join(audioDir, `long-${SECONDS}s.wav`), SECONDS, 7), path);

// The selection, as fractions of the file's length and of its pitch range.
const SELECTION = { from: 0.4, to: 0.47, pitchLo: 0.3, pitchHi: 0.7 };
const points = [];
for (let i = 0; i < 300; i++) points.push({ f: 0.05 + (0.9 * i) / 299, p: 0.15 + (0.7 * ((i * 37) % 100)) / 100 });
const clearlyInside = (pt) =>
  pt.f > SELECTION.from + 0.005 && pt.f < SELECTION.to - 0.005 && pt.p > 0.35 && pt.p < 0.65;
const clearlyOutside = (pt) => pt.f < SELECTION.from - 0.01 || pt.f > SELECTION.to + 0.01 || pt.p < 0.25 || pt.p > 0.75;
// Extra points inside the selection, so the inside is checked at more than a few places.
for (let i = 0; i < 60; i++) {
  points.push({
    f: SELECTION.from + 0.01 + ((SELECTION.to - SELECTION.from - 0.02) * i) / 59,
    p: 0.36 + (0.28 * ((i * 17) % 60)) / 60,
  });
}

const env = build({ skip: args.includes("--no-build"), windowBlocks: option("window-blocks", undefined) });
const { app, page, profile } = await launch(env);
let failed = false;
const fail = (message) => {
  failed = true;
  console.log(`FAIL ${message}`);
};

try {
  await openFiles(app, page, [path]);
  const owner = (await viewOf(page)).id;
  const state = () =>
    page.evaluate(() => {
      const s = globalThis.__store.getState();
      return {
        open: s.openFileIds,
        detached: Object.keys(s.detachedLayers),
        busy: Object.keys({ ...s.filesBusy, ...s.filesLoading, ...s.filesSynthesizing }).filter(
          (id) => s.filesBusy[id] || s.filesLoading[id] || s.filesSynthesizing[id],
        ),
      };
    });
  const settle = async () => {
    await sleep(1000);
    for (let i = 0; i < 1200 && (await state()).busy.length > 0; i++) await sleep(250);
  };
  const channels = (id) =>
    page.evaluate(({ id, points }) => globalThis.__readTruth(id, points).then((r) => r.map((x) => x.storeChannels)), {
      id,
      points,
    });
  const send = (channel) =>
    app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send(c), channel);
  const same = (a, b) => a.every((pair, i) => pair.every((value, ch) => Object.is(value, b[i][ch])));

  await settle();
  const original = await channels(owner);
  await page.evaluate(
    ({ owner, s, seconds }) =>
      globalThis.__store.getState().setFileSelection(owner, {
        start: s.from * seconds,
        end: s.to * seconds,
        pitchLo: s.pitchLo,
        pitchHi: s.pitchHi,
      }),
    { owner, s: SELECTION, seconds: SECONDS },
  );

  const t0 = Date.now();
  await page.evaluate((id) => void globalThis.__store.getState().hpssFile(id), owner);
  for (let i = 0; i < 2400 && (await state()).open.length < 2; i++) await sleep(250);
  await settle();
  console.log(`split selection took ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const layer = (await state()).open.find((id) => id !== owner);
  if (!layer) throw new Error("the split added no layer");
  const [first, second] = [await channels(owner), await channels(layer)];
  let worst = 0;
  let insideChanged = 0;
  let insideCount = 0;
  let notSilent = 0;
  let changedOutside = 0;
  points.forEach((pt, i) => {
    for (let ch = 0; ch < 2; ch++) {
      const scale = Math.max(Math.abs(original[i][ch]), 1e-6);
      worst = Math.max(worst, Math.abs(first[i][ch] + second[i][ch] - original[i][ch]) / scale);
      if (clearlyOutside(pt)) {
        if (second[i][ch] !== 0) notSilent++;
        if (!Object.is(first[i][ch], original[i][ch])) changedOutside++;
      }
    }
    if (clearlyInside(pt)) {
      insideCount++;
      if (second[i][0] !== 0 || second[i][1] !== 0) insideChanged++;
    }
  });
  if (notSilent > 0) fail(`${notSilent} values outside the selection are not silent in the layer`);
  if (changedOutside > 0) fail(`${changedOutside} values outside the selection changed in the file`);
  if (notSilent === 0 && changedOutside === 0)
    console.log("outside the selection: the file is unchanged, the layer silent");
  if (worst > 1e-3) fail(`the parts do not add up: worst relative error ${worst}`);
  else console.log(`the parts add up to the original (worst relative error ${worst.toExponential(2)})`);
  if (insideChanged < insideCount * 0.9) fail(`only ${insideChanged} of ${insideCount} points inside hold a part`);
  else console.log(`${insideChanged} of ${insideCount} points inside the selection hold a part`);

  await send("undo");
  for (let i = 0; i < 400 && (await state()).open.includes(layer); i++) await sleep(100);
  await settle();
  if (!(await state()).detached.includes(layer)) fail("undo did not take the layer away");
  if (!same(await channels(owner), original)) fail("undo did not put the original back");
  else console.log("undo: the original is back");

  await send("redo");
  for (let i = 0; i < 1200 && !(await state()).open.includes(layer); i++) await sleep(100);
  await settle();
  if (!same(await channels(owner), first) || !same(await channels(layer), second))
    fail("redo did not bring both parts back");
  else console.log("redo: both parts are back");
} finally {
  await closeApp(app, profile);
}
if (failed) process.exitCode = 1;
