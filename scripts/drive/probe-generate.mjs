// Checks Generate in the built app: a restyle, a fill and a Selection-input
// restyle in selections of a long file, undo, the dialog, and a whole-file
// restyle of a short file, reading the stored result and timing each.
//
// Usage: node scripts/drive/probe-generate.mjs [--seconds 285] [--no-build]
import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, closeApp, launch, openFiles, root, sleep, viewOf, writeNoise } from "./app.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SECONDS = Number(option("seconds", 285));
const CHANGED_DB = 1;

const audioDir = join(tmpdir(), "noisecanvas-noise");
const longPath = join(audioDir, `long-${SECONDS}s-${process.pid}.wav`);
copyFileSync(writeNoise(join(audioDir, `long-${SECONDS}s.wav`), SECONDS, 7), longPath);
const shortPath = join(audioDir, `break-${process.pid}.mp3`);
copyFileSync(join(root, "resources/samples/break-loop.mp3"), shortPath);

const env = build({ skip: args.includes("--no-build") });
const { app, page, profile } = await launch(env);
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

try {
  await openFiles(app, page, [longPath]);
  const { id } = await viewOf(page);
  await sleep(3000);

  const settle = async () => {
    for (let i = 0; i < 2400; i++) {
      const busy = await page.evaluate(() => {
        const state = globalThis.__store.getState();
        return (
          Object.values(state.filesBusy ?? {}).some(Boolean) || Object.values(state.filesLoading ?? {}).some(Boolean)
        );
      });
      if (!busy) break;
      await sleep(250);
    }
    await sleep(1500);
  };
  const levels = async (fileId, points) =>
    (
      await page.evaluate(async ({ fileId, points }) => await globalThis.__readTruth(fileId, points), {
        fileId,
        points,
      })
    ).map((r) => 20 * Math.log10((r.store + 1e-9) / (r.original + 1e-9)));
  const changed = (dbs) => dbs.filter((db) => Math.abs(db) > CHANGED_DB).length;
  const mostlyChanged = (dbs) => changed(dbs) >= dbs.length / 3;
  const show = (dbs) => `${changed(dbs)}/${dbs.length} points moved`;
  const send = (channel) =>
    app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send(c), channel);

  const generate = async (label, fileId, selection, settings) => {
    const started = Date.now();
    await page.evaluate(
      async ({ fileId, selection, settings }) => {
        const state = globalThis.__store.getState();
        await state.setActiveFileId(fileId);
        if (selection) state.setFileSelection(fileId, selection);
        else state.setFileSelection(fileId, null);
        await globalThis.__store.getState().generateIntoActiveFile(settings);
      },
      { fileId, selection, settings },
    );
    await settle();
    console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  };

  const probePoints = (region, pitch) => {
    const lo = Math.max(region.pitchLo + 0.03, pitch - 0.08);
    const hi = Math.min(region.pitchHi - 0.03, pitch + 0.08);
    const inside = [0.1, 0.3, 0.5, 0.7, 0.9].flatMap((u) =>
      [lo, pitch, hi].map((p) => ({ f: (region.start + u * (region.end - region.start)) / SECONDS, p })),
    );
    const outsideTime = [region.start - 3, region.end + 3].map((t) => ({ f: t / SECONDS, p: pitch }));
    return { inside, outsideTime };
  };

  // A band-limited restyle, as the model hears the full mix.
  const restyle = { start: 100, end: 104, pitchLo: 0.5, pitchHi: 0.8 };
  const r = probePoints(restyle, 0.65);
  const belowBand = [{ f: 102 / SECONDS, p: 0.3 }];
  await generate("restyle 80% (first run loads the model)", id, restyle, {
    prompt: "warm felt piano chords",
    strength: 0.8,
    input: "full-mix",
  });
  const rIn = await levels(id, r.inside);
  const rOut = await levels(id, [...r.outsideTime, ...belowBand]);
  check(mostlyChanged(rIn), `restyle changes the region (${show(rIn)})`);
  check(
    changed(rOut) === 0,
    `restyle leaves time and bands outside it alone (${rOut.map((d) => d.toFixed(1)).join(", ")} dB)`,
  );

  await send("undo");
  await sleep(4000);
  const undone = await levels(id, r.inside);
  check(changed(undone) === 0, `undo restores the region (${show(undone)})`);

  // A full-height fill.
  const fill = { start: 200, end: 201.5, pitchLo: 0, pitchHi: 1 };
  const f = probePoints(fill, 0.6);
  await generate("fill 100%", id, fill, { prompt: "rain on a window", strength: 1, input: "full-mix" });
  const fIn = await levels(id, f.inside);
  const fOut = await levels(id, f.outsideTime);
  check(mostlyChanged(fIn), `fill changes the region (${show(fIn)})`);
  check(changed(fOut) === 0, `fill leaves the time around it alone (${fOut.map((d) => d.toFixed(1)).join(", ")} dB)`);

  // A band-limited restyle, as the model hears only the selected bands.
  const selectionInput = { start: 150, end: 153, pitchLo: 0.2, pitchHi: 0.45 };
  const s = probePoints(selectionInput, 0.33);
  await generate("restyle 70%, Selection input", id, selectionInput, {
    prompt: "deep sub bass",
    strength: 0.7,
    input: "selection",
  });
  const sIn = await levels(id, s.inside);
  const sOut = await levels(id, [...s.outsideTime, { f: 151.5 / SECONDS, p: 0.7 }]);
  check(mostlyChanged(sIn), `Selection input changes the region (${show(sIn)})`);
  check(changed(sOut) === 0, `Selection input leaves the rest alone (${sOut.map((d) => d.toFixed(1)).join(", ")} dB)`);

  // The dialog, typed into and confirmed the way a person does.
  const dialogRegion = { start: 250, end: 252, pitchLo: 0, pitchHi: 1 };
  const d = probePoints(dialogRegion, 0.5);
  await page.evaluate(
    ({ id, region }) => {
      const state = globalThis.__store.getState();
      state.setFileSelection(id, region);
      void state.promptGenerate();
    },
    { id, region: dialogRegion },
  );
  await page.getByLabel("Prompt").fill("glass wind chimes");
  const started = Date.now();
  await page.getByRole("dialog").getByRole("button", { name: "Generate", exact: true }).click();
  await sleep(500);
  await settle();
  console.log(`dialog generate: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const dIn = await levels(id, d.inside);
  check(mostlyChanged(dIn), `the dialog's Generate changes the selection (${show(dIn)})`);

  // A whole-file restyle of a short file.
  await openFiles(app, page, [shortPath]);
  const short = await page.evaluate((long) => globalThis.__store.getState().openFileIds.find((f) => f !== long), id);
  await sleep(2000);
  const shortPoints = [0.2, 0.5, 0.8].flatMap((f) => [0.3, 0.6].map((p) => ({ f, p })));
  const openIds = await page.evaluate(() => globalThis.__store.getState().openFileIds);
  console.log(`open files ${openIds.join(", ")}; short ${short}, long ${id}`);
  const stored = async () =>
    (
      await page.evaluate(async ({ short, points }) => await globalThis.__readTruth(short, points), {
        short,
        points: shortPoints,
      })
    ).map((x) => x.store);
  const beforeWhole = await stored();
  await generate("whole-file restyle 75%", short, null, {
    prompt: "orchestral taiko drums",
    strength: 0.75,
    input: "full-mix",
  });
  const afterWhole = await stored();
  const wDb = afterWhole.map((v, i) => 20 * Math.log10((v + 1e-9) / (beforeWhole[i] + 1e-9)));
  check(mostlyChanged(wDb), `whole-file restyle changes the file (${show(wDb)})`);
  const errors = await page.evaluate(() => document.body.innerText.includes("Generate failed"));
  check(!errors, "no Generate failure was shown");

  // AI stems, which run through the same ONNX Runtime on the GPU.
  const beforeStems = (await page.evaluate(() => globalThis.__store.getState().openFileIds)).length;
  const stemsStarted = Date.now();
  await page.evaluate(async (short) => await globalThis.__store.getState().aiSeparateFile(short), short);
  await settle();
  const stems = (await page.evaluate(() => globalThis.__store.getState().openFileIds)).length - beforeStems;
  console.log(`AI stems: ${((Date.now() - stemsStarted) / 1000).toFixed(1)} s`);
  check(stems === 4, `AI separation adds four stems (${stems})`);
  const stemErrors = await page.evaluate(() => document.body.innerText.includes("AI separation failed"));
  check(!stemErrors, "no separation failure was shown");
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  await closeApp(app, profile);
}

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
