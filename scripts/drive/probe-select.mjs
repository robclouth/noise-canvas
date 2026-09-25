// Checks the selection features on a long file: silence a region, copy it,
// paste it elsewhere, and audition it, reading the stored result.
//
// Usage: node scripts/drive/probe-select.mjs [--seconds 285] [--no-build]
import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, launch, openFiles, sleep, viewOf, writeNoise } from "./app.mjs";

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
const { app, page, console: consoleLines } = await launch(env);
const failures = [];
try {
  await openFiles(app, page, [longPath]);
  const { id } = await viewOf(page);
  await sleep(3000);
  const at = (f, p) => ({ f, p });
  const truth = async (points) =>
    await page.evaluate(async ({ id, points }) => await globalThis.__readTruth(id, points), { id, points });
  const ratio = (r) => r.store / r.original;

  const source = { start: SECONDS * 0.52, end: SECONDS * 0.52 + 6, pitchLo: 0.4, pitchHi: 0.7 };
  await page.evaluate(
    async ({ id, source }) => {
      const state = globalThis.__store.getState();
      await state.setActiveFileId(id);
      state.setFileSelection(id, source);
      await globalThis.__store.getState().silenceSelection();
    },
    { id, source },
  );
  await sleep(4000);
  const silenced = await truth([at((source.start + 3) / SECONDS, 0.55)]);
  console.log(`silenced: store/original ${ratio(silenced[0]).toExponential(2)}`);
  if (ratio(silenced[0]) > 0.01) failures.push("silence did not reach the store");

  const audition = await page.evaluate(
    async ({ id, source }) => {
      const buffer = await globalThis.__store.getState().selectionAuditionBuffer(id, source);
      return buffer ? { length: buffer.length, channels: buffer.numberOfChannels } : null;
    },
    { id, source },
  );
  console.log(`audition: ${JSON.stringify(audition)}`);
  if (!audition || audition.length === 0) failures.push("audition gave no buffer");

  await page.evaluate(async () => {
    await globalThis.__store.getState().copySelection();
  });
  await sleep(500);
  const placing = await page.evaluate(() => Boolean(globalThis.__store.getState().placing));
  console.log(`copy started placing: ${placing}`);
  if (!placing) failures.push("copy did not pick the region up");
  const to = SECONDS * 0.7;
  await page.evaluate(async (to) => {
    const state = globalThis.__store.getState();
    state.movePlacing(to, 0.4);
    await state.dropPlacing();
  }, to);
  await sleep(6000);
  const pasted = await truth([at((to + 3) / SECONDS, 0.55), at((source.start + 0.5) / SECONDS, 0.55), at(0.97, 0.55)]);
  console.log(`pasted: ${pasted.map((r) => ratio(r).toExponential(2)).join(", ")} (paste, source, untouched)`);
  if (ratio(pasted[0]) > 0.01) failures.push("the pasted region is not the silenced copy");
  if (ratio(pasted[2]) < 0.5) failures.push("an untouched region changed");
  for (const c of consoleLines)
    if (c.type === "error" && !/HRTF|valid audio stream/.test(c.text))
      failures.push(`console: ${c.text.slice(0, 200)}`);
} finally {
  await app.close().catch(() => {});
}
console.log(failures.length ? `FAILED\n  ${failures.join("\n  ")}` : "OK");
process.exit(failures.length ? 1 : 0);
