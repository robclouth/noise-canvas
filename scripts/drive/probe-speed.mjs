// Times edits on a long file: a full-length erase, a full-length reversal and
// a full-length copy from a second file, then erases of two and eight beats
// and a two-beat reversal.
// For each it prints the wait from pen up to the commit, and the "beside dab"
// diag line: tiles, texels, and the milliseconds spent reading, setting up,
// painting and reading back.
//
// Usage: node scripts/drive/probe-speed.mjs [--seconds 285] [--runs 2] [--log keep.log]
//        [--profile out.cpuprofile] [--no-build]
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { build, closeApp, diagLines, launch, openFiles, seedEraseBrush, sleep, viewOf, writeNoise } from "./app.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SECONDS = Number(option("seconds", 285));
const RUNS = Number(option("runs", 2));

const audioDir = join(tmpdir(), "noisecanvas-noise");
const longPath = join(audioDir, `long-${SECONDS}s-${process.pid}.wav`);
copyFileSync(writeNoise(join(audioDir, `long-${SECONDS}s.wav`), SECONDS, 7), longPath);
const sourcePath = join(audioDir, `long-${SECONDS}s-b-${process.pid}.wav`);
copyFileSync(writeNoise(join(audioDir, `long-${SECONDS}s-b.wav`), SECONDS, 11), sourcePath);

const env = build({ skip: args.includes("--no-build") });
const { app, page, profile, logPath } = await launch(env);
const results = [];
try {
  await openFiles(app, page, [longPath, sourcePath]);
  await seedEraseBrush(page, { size: 6 });
  const id = await page.evaluate((name) => {
    const names = globalThis.__store.getState().fileDisplayNames;
    return Object.keys(names).find((key) => names[key] === name);
  }, basename(longPath));
  await page.evaluate(async (id) => await globalThis.__store.getState().setActiveFileId(id), id);
  const b = await viewOf(page, id);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.down("Meta");
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 100);
  await page.keyboard.up("Meta");
  await sleep(3000);

  const commits = () => diagLines(logPath, /commit history add/).length;
  const besideLines = () => diagLines(logPath, /beside dab/);
  const setStep = async (key, value) =>
    await page.evaluate(({ key, value }) => globalThis.__store.getState().setParameter(key, value), { key, value });
  const profileTo = option("profile", null);
  const cdp = profileTo ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  }
  const timeDab = async (name, fy) => {
    if (cdp) await cdp.send("Profiler.start");
    const before = commits();
    const besideBefore = besideLines().length;
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * fy);
    await sleep(300);
    await page.mouse.down();
    await sleep(40);
    await page.mouse.up();
    const upAt = performance.now();
    const upClock = new Date().toISOString();
    for (let i = 0; i < 2400 && commits() <= before; i++) await sleep(50);
    const waitMs = Math.round(performance.now() - upAt);
    if (cdp) {
      const { profile: cpu } = await cdp.send("Profiler.stop");
      writeFileSync(profileTo.replace(/\.cpuprofile$/, `-${name}-${results.length}.cpuprofile`), JSON.stringify(cpu));
    }
    const beside = besideLines()
      .slice(besideBefore)
      .map((entry) => entry.data ?? {});
    const sum = (key) => Math.round(beside.reduce((total, entry) => total + (entry[key] ?? 0), 0));
    const row = {
      name,
      up: upClock,
      waitMs,
      dabs: beside.length,
      tiles: sum("tiles"),
      texels: sum("texels"),
      readMs: sum("readMs"),
      setupMs: sum("setupMs"),
      paintMs: sum("paintMs"),
      readbackMs: sum("readbackMs"),
      besideMs: sum("totalMs"),
    };
    results.push(row);
    console.log(JSON.stringify(row));
    await sleep(1500);
  };

  for (let run = 0; run < RUNS; run++) {
    await page.evaluate(() =>
      globalThis.__store
        .getState()
        .setParameter("effects", [
          { id: "drive-erase", effect: "dynamics", enabled: true, params: { dynamicsGainDb: -60 } },
        ]),
    );
    await setStep("sourceFile", null);
    await setStep("brushSizeTime", 32);
    await timeDab("erase", 0.3);
    await page.evaluate(() =>
      globalThis.__store.getState().setParameter("effects", [
        {
          id: "drive-reverse",
          effect: "transform",
          enabled: true,
          params: { transformScaleTime: -1, transformEdgeMode: 0 },
        },
      ]),
    );
    await timeDab("reverse", 0.5);
    await page.evaluate((path) => {
      const state = globalThis.__store.getState();
      state.setParameter("effects", [{ id: "drive-copy", effect: "passthrough", enabled: true, params: {} }]);
      state.setParameter("sourceFile", { path });
    }, sourcePath);
    await timeDab("copy", 0.7);
    // Strokes of an everyday size: two beats and eight beats.
    await setStep("sourceFile", null);
    await page.evaluate(() =>
      globalThis.__store
        .getState()
        .setParameter("effects", [
          { id: "drive-erase", effect: "dynamics", enabled: true, params: { dynamicsGainDb: -60 } },
        ]),
    );
    await setStep("brushSizeTime", 2);
    await timeDab("erase 2 beats", 0.35);
    await setStep("brushSizeTime", 8);
    await timeDab("erase 8 beats", 0.4);
    await page.evaluate(() =>
      globalThis.__store.getState().setParameter("effects", [
        {
          id: "drive-reverse",
          effect: "transform",
          enabled: true,
          params: { transformScaleTime: -1, transformEdgeMode: 0 },
        },
      ]),
    );
    await setStep("brushSizeTime", 2);
    await timeDab("reverse 2 beats", 0.55);
  }
} finally {
  const keep = option("log", null);
  if (keep && existsSync(logPath)) copyFileSync(logPath, keep);
  await closeApp(app, profile);
}
