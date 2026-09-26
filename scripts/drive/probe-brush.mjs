// Checks brushes that reach past the canvas window on a long file: one dab of
// a brush the length of the file, one dab of a brush that wraps past the
// file's end, one full-length dab that paints from a second long file, one
// dab that copies this file from far along it, and one full-length reversal,
// each read back from the store.
//
// Usage: node scripts/drive/probe-brush.mjs [--seconds 285] [--no-build]
import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { build, diagLines, launch, openFiles, seedEraseBrush, sleep, viewOf, writeNoise, closeApp } from "./app.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SECONDS = Number(option("seconds", 285));

const audioDir = join(tmpdir(), "noisecanvas-noise");
const longPath = join(audioDir, `long-${SECONDS}s-${process.pid}.wav`);
copyFileSync(writeNoise(join(audioDir, `long-${SECONDS}s.wav`), SECONDS, 7), longPath);
const sourcePath = join(audioDir, `long-${SECONDS}s-b-${process.pid}.wav`);
copyFileSync(writeNoise(join(audioDir, `long-${SECONDS}s-b.wav`), SECONDS, 11), sourcePath);

const env = build({ skip: args.includes("--no-build") });
const { app, page, profile, logPath, console: consoleLines } = await launch(env);
const failures = [];
try {
  await openFiles(app, page, [longPath, sourcePath]);
  await seedEraseBrush(page, { size: 6 });
  const idOf = async (path) =>
    await page.evaluate((name) => {
      const names = globalThis.__store.getState().fileDisplayNames;
      return Object.keys(names).find((key) => names[key] === name);
    }, basename(path));
  const id = await idOf(longPath);
  const sourceId = await idOf(sourcePath);
  await page.evaluate(async (id) => await globalThis.__store.getState().setActiveFileId(id), id);
  await page.evaluate(() => {
    globalThis.__dabLog = [];
  });
  const b = await viewOf(page, id);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.down("Meta");
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 100);
  await page.keyboard.up("Meta");
  await sleep(3000);

  const commits = () => diagLines(logPath, /commit history add/).length;
  const truthOf = async (fileId, points) =>
    await page.evaluate(async ({ id, points }) => await globalThis.__readTruth(id, points), { id: fileId, points });
  const truth = async (points) => await truthOf(id, points);
  const erased = (r) => r.original > 0 && r.store / r.original < 0.01;
  const clickAt = async (fx, fy) => {
    const before = commits();
    await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy);
    await sleep(300);
    await page.mouse.down();
    await sleep(40);
    await page.mouse.up();
    for (let i = 0; i < 480 && commits() <= before; i++) await sleep(250);
    await sleep(1000);
    const dabs = await page.evaluate((id) => globalThis.__dabLog.filter((d) => d.fileId === id), id);
    return dabs[dabs.length - 1];
  };
  const setStep = async (key, value) =>
    await page.evaluate(({ key, value }) => globalThis.__store.getState().setParameter(key, value), { key, value });

  // A brush the length of the file, one dab.
  await setStep("brushSizeTime", 32);
  const started = performance.now();
  const full = await clickAt(0.5, 0.45);
  console.log(`full-length dab committed in ${Math.round(performance.now() - started)} ms`);
  if (!full) failures.push("the full-length dab was never logged");
  else {
    const p = full.y + full.height / 2;
    console.log(`full-length dab pitch ${full.y.toFixed(3)}-${(full.y + full.height).toFixed(3)}`);
    const across = Array.from({ length: 30 }, (_, i) => ({ f: (i + 0.5) / 30, p }));
    const readings = await truth(across);
    const missed = readings.map((r, i) => (erased(r) ? null : ((i + 0.5) / 30).toFixed(3))).filter(Boolean);
    console.log(`full-length: ${readings.length - missed.length}/${readings.length} erased`);
    if (missed.length > 0) failures.push(`the full-length dab missed ${missed.join(", ")}`);
  }

  // A brush that wraps past the end of the file, at a pitch the first dab left alone.
  await setStep("brushSizeTime", 8);
  await setStep("brushWrapMode", 1);
  const wrapPitch = 0.75;
  const wrap = await clickAt(0.998, wrapPitch);
  if (!wrap) failures.push("the wrapping dab was never logged");
  else {
    const p = wrap.y + wrap.height / 2;
    const fractions = [0.1, 0.3, 0.5, 0.7, 0.9].map((g) => (wrap.x + wrap.width * g) % 1);
    const inside = await truth(fractions.map((f) => ({ f, p })));
    const outside = await truth([{ f: 0.5, p }]);
    console.log(`wrap dab pitch ${wrap.y.toFixed(3)}-${(wrap.y + wrap.height).toFixed(3)}`);
    console.log(
      `wrap: dab at ${wrap.x.toFixed(4)}+${wrap.width.toFixed(4)}, ` +
        `${inside.filter(erased).length}/${inside.length} erased, middle ${erased(outside[0]) ? "erased" : "untouched"}`,
    );
    if (!(wrap.x + wrap.width > 1)) failures.push("the wrapping dab did not cross the end of the file");
    if (inside.some((r) => !erased(r))) failures.push("the wrapping dab missed part of itself");
    if (erased(outside[0])) failures.push("the wrapping dab reached the middle of the file");
  }
  // A full-length dab that copies the second file, at a pitch the others left alone.
  await setStep("brushWrapMode", 0);
  await setStep("brushSizeTime", 32);
  await page.evaluate((path) => {
    const state = globalThis.__store.getState();
    state.setParameter("effects", [{ id: "drive-copy", effect: "passthrough", enabled: true, params: {} }]);
    state.setParameter("sourceFile", { path });
  }, sourcePath);
  const copy = await clickAt(0.5, 0.6);
  if (!copy) failures.push("the full-length copy dab was never logged");
  else {
    const p = copy.y + copy.height / 2;
    const across = Array.from({ length: 30 }, (_, i) => ({ f: (i + 0.5) / 30, p }));
    const [dest, source] = [await truth(across), await truthOf(sourceId, across)];
    const copied = dest.map((r, i) => Math.abs(Math.log(r.store / source[i].store)) < 0.05);
    const unlike = dest.filter((r, i) => Math.abs(Math.log(r.original / source[i].store)) > 0.05).length;
    const missed = copied.map((ok, i) => (ok ? null : ((i + 0.5) / 30).toFixed(3))).filter(Boolean);
    console.log(`copy: ${copied.length - missed.length}/${copied.length} match the source (${unlike} differed before)`);
    if (missed.length > 0)
      for (const i of copied.map((ok, i) => (ok ? -1 : i)).filter((i) => i >= 0))
        console.log(
          `  at ${((i + 0.5) / 30).toFixed(3)}: dest ${dest[i].store.toExponential(2)} (was ${dest[i].original.toExponential(2)}), source ${source[i].store.toExponential(2)}`,
        );
    if (unlike < 20) failures.push("the two files are too alike to tell a copy");
    if (missed.length > 0) failures.push(`the full-length copy missed ${missed.join(", ")}`);
  }
  // A dab near the start that copies this file from 80% of the way along. Fixed
  // holds pitch as well, so a first dab finds the brush's pitch and Source
  // Pitch is set to it: the clone then reads the band it writes.
  await setStep("brushSizeTime", 1);
  await page.evaluate(() => {
    const state = globalThis.__store.getState();
    state.setParameter("sourceFile", null);
    state.setParameter("sourcePositionMode", "fixed");
    state.setParameter("sourceTimeOffset", 80);
  });
  const found = await clickAt(0.05, 0.3);
  if (found) await setStep("sourcePitchOffset", found.y * 100);
  const clone = await clickAt(0.1, 0.3);
  if (!clone) failures.push("the far clone dab was never logged");
  else {
    const p = clone.y + clone.height / 2;
    const at = [0.3, 0.5, 0.7].map((g) => clone.width * g);
    const dest = await truth(at.map((dx) => ({ f: clone.x + dx, p })));
    const src = await truth(at.map((dx) => ({ f: 0.8 + dx, p })));
    // The read falls between bins, so a copied point is near its source value
    // and much nearer it than the value it had before.
    const matched = dest.filter((r, i) => {
      const off = Math.abs(Math.log(r.store / src[i].store));
      return off < 0.35 && off < 0.5 * Math.abs(Math.log(r.original / src[i].store));
    }).length;
    const differed = dest.filter((r, i) => Math.abs(Math.log(r.original / src[i].store)) > 0.05).length;
    console.log(
      `far clone: dab at ${clone.x.toFixed(4)}, ${matched}/${dest.length} match 80% (${differed} differed before)`,
    );
    for (let i = 0; i < dest.length; i++)
      console.log(
        `  +${at[i].toFixed(5)}: dest ${dest[i].store.toExponential(3)} (was ${dest[i].original.toExponential(3)}), 80% ${src[i].store.toExponential(3)}`,
      );
    if (differed < 2) failures.push("the dab and 80% are too alike to tell a clone");
    if (matched < dest.length) failures.push("the far clone did not copy from 80% of the file");
  }
  // A full-length reversal, at a pitch the others left alone: every block of it
  // reads the far end of the file, which no window holds beside it.
  await page.evaluate(() => {
    const state = globalThis.__store.getState();
    state.setParameter("sourcePositionMode", "follow");
    state.setParameter("sourceTimeOffset", 0);
    state.setParameter("effects", [
      {
        id: "drive-reverse",
        effect: "transform",
        enabled: true,
        params: { transformScaleTime: -1, transformEdgeMode: 0 },
      },
    ]);
  });
  await setStep("brushSizeTime", 32);
  const reverseStarted = performance.now();
  const reversed = await clickAt(0.5, 0.15);
  console.log(`full-length reversal committed in ${Math.round(performance.now() - reverseStarted)} ms`);
  if (!reversed) failures.push("the full-length reversal was never logged");
  else {
    const p = reversed.y + reversed.height / 2;
    // Inside the brush's fades, where the reversal replaces the file outright.
    const fractions = [0.25, 0.4, 0.6, 0.75];
    const dest = await truth(fractions.map((f) => ({ f, p })));
    const mirror = await truth(fractions.map((f) => ({ f: 1 - f, p })));
    const matched = dest.filter((r, i) => {
      const off = Math.abs(Math.log(r.store / mirror[i].original));
      return off < 0.35 && off < 0.5 * Math.abs(Math.log(r.original / mirror[i].original));
    }).length;
    console.log(`reversal: ${matched}/${dest.length} hold the file's other end`);
    for (let i = 0; i < dest.length; i++)
      console.log(
        `  at ${fractions[i]}: dest ${dest[i].store.toExponential(3)} (was ${dest[i].original.toExponential(3)}), mirror ${mirror[i].original.toExponential(3)}`,
      );
    if (matched < dest.length) failures.push("the full-length reversal did not mirror the file");
  }
  for (const c of consoleLines)
    if (c.type === "error" && !/HRTF|valid audio stream/.test(c.text))
      failures.push(`console: ${c.text.slice(0, 200)}`);
} finally {
  await closeApp(app, profile);
}
console.log(failures.length ? `FAILED\n  ${failures.join("\n  ")}` : "OK");
process.exit(failures.length ? 1 : 0);
