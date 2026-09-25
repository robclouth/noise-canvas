// Drives a long file the way a person does and measures what they feel.
//
// Opens one long stereo file with short files beside it, seeds an erase brush,
// then runs a seeded session: quick strokes zoomed out, zooms in, trackpad
// scrolls with momentum, strokes zoomed in, zooms back out. It reports:
//   - frame gaps (rAF intervals over 34 ms) and long tasks, by gesture
//   - preview latency: how long after the pointer passed a column the erase shows
//   - paint loss: stroke points that showed erased and later did not, or never did
//   - CPU seconds and memory of every app process, main-thread busy share by gesture
//   - the app's own commit timings and warnings
//
// Usage: node scripts/drive/session.mjs [--seconds 285] [--extra 8] [--gestures 60]
//        [--seed 1] [--no-build] [--profile] [--window-blocks N] [--out dir]
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  build,
  diagLines,
  fileFraction,
  grab,
  installProbes,
  launch,
  openFiles,
  quantiles,
  readProbes,
  readProcessSamples,
  rng,
  savePng,
  screenFraction,
  seedEraseBrush,
  sleep,
  startCapture,
  startProcessSampler,
  stopCapture,
  tag,
  viewOf,
  viewState,
  writeNoise,
} from "./app.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const SECONDS = Number(option("seconds", 285));
const EXTRA = Number(option("extra", 8));
const GESTURES = Number(option("gestures", 60));
const SEED = Number(option("seed", 1));
const OUT = option("out", join(tmpdir(), `noisecanvas-session-${Date.now()}`));
const windowBlocks = option("window-blocks", undefined);
mkdirSync(OUT, { recursive: true });

const random = rng(SEED);
const audioDir = join(tmpdir(), "noisecanvas-noise");
const extraLengths = [2.8, 7.1, 10.9, 13.7, 13.7, 13.7, 21.5, 13.7, 5, 9];
const tag_ = `${process.pid}`;
const extras = extraLengths
  .slice(0, EXTRA)
  .map((s, i) => writeNoise(join(audioDir, `short-${i}-${s}s.wav`), s, 100 + i));
const longSource = writeNoise(join(audioDir, `long-${SECONDS}s.wav`), SECONDS, 7);
// A fresh name per run, so nothing the app caches by path is reused.
const longPath = join(audioDir, `long-${SECONDS}s-${tag_}.wav`);
await import("node:fs").then(({ copyFileSync }) => copyFileSync(longSource, longPath));

const env = build({ windowBlocks, skip: flag("no-build") });
const { app, page, logPath, console: consoleLines } = await launch(env);
let stallProfile = null;
const report = { seconds: SECONDS, extra: EXTRA, seed: SEED, gestures: [], strokes: [], checks: [] };

try {
  process.stdout.write(`opening ${EXTRA} short files and one of ${SECONDS} s… `);
  const openStart = Date.now();
  await openFiles(app, page, [...extras, longPath]);
  report.openMs = Date.now() - openStart;
  process.stdout.write(`${(report.openMs / 1000).toFixed(1)} s\n`);
  await seedEraseBrush(page);
  const first = await viewOf(page);
  const fileId = first.id;
  const allocated = diagLines(logPath, /textures allocated/).map((l) => l.data);
  report.windowBlocks = allocated.find((d) => d?.seconds >= SECONDS - 1)?.windowBlocks ?? null;
  console.log(
    `long file view ${fileId}, ${Math.round(first.width)}×${Math.round(first.height)}, window blocks ${report.windowBlocks}`,
  );

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  if (flag("profile")) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
    report.profilePerfStart = await page.evaluate(() => performance.now());
  }
  if (flag("heap")) {
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.startSampling", {
      samplingInterval: 128 * 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  await installProbes(page);
  await page.evaluate(() => {
    globalThis.__dabLog = [];
  });
  await startProcessSampler(app);

  const box = async () => await viewOf(page, fileId);
  const mainThread = {};
  const metricsNow = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
    return { task: get("TaskDuration"), script: get("ScriptDuration"), t: Date.now() };
  };

  /** Runs one gesture, tagging the probes and charging main-thread time to it. */
  const gesture = async (kind, fn) => {
    await tag(page, kind);
    const before = await metricsNow();
    const start = Date.now();
    const detail = await fn();
    const after = await metricsNow();
    await tag(page, "idle");
    const wall = Date.now() - start;
    const m = (mainThread[kind] ??= { wallMs: 0, taskMs: 0, scriptMs: 0, count: 0 });
    m.wallMs += wall;
    m.taskMs += (after.task - before.task) * 1000;
    m.scriptMs += (after.script - before.script) * 1000;
    m.count++;
    report.gestures.push({ kind, start, wallMs: wall, ...(detail ?? {}) });
    return detail;
  };

  // Pointer paths. A person's hand eases in and out and wobbles a little.
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

  const stroke = async ({ from, to, via, v, durationMs, measure }) => {
    const b = await box();
    const view = await viewState(page, fileId);
    const y0 = b.y + b.height * v;
    const keys = [from, ...(via ? [via] : []), to];
    const samples = [];
    const stepMs = 8;
    const steps = Math.max(2, Math.round(durationMs / stepMs));
    const pointAt = (s) => {
      const segs = keys.length - 1;
      const pos = ease(s) * segs;
      const k = Math.min(segs - 1, Math.floor(pos));
      const f = pos - k;
      return keys[k] + (keys[k + 1] - keys[k]) * f;
    };
    const strip = { x: Math.round(b.x), y: Math.round(y0 - 1), width: Math.round(b.width), height: 3 };
    if (measure) {
      await page.mouse.move(b.x + b.width * from, y0);
      await startCapture(app, strip);
      await sleep(120);
    }
    const t0 = Date.now();
    await page.mouse.move(b.x + b.width * from, y0);
    await page.mouse.down();
    const moves = [];
    for (let i = 1; i <= steps; i++) {
      const target = t0 + i * stepMs;
      const wait = target - Date.now();
      if (wait > 0) await sleep(wait);
      const u = pointAt(i / steps);
      const x = b.x + b.width * u + (random() - 0.5) * 2;
      const y = y0 + (random() - 0.5) * 3;
      // Sent at the hand's pace; the app takes them as its frames allow.
      moves.push(page.mouse.move(x, y));
      samples.push({ t: Date.now(), x, y, f: fileFraction((x - b.x) / b.width, view), v: (y - b.y) / b.height });
    }
    await Promise.all(moves);
    await page.mouse.up();
    const record = { id: report.strokes.length, t0, t1: Date.now(), power: view.power, offset: view.offset, samples };
    report.strokes.push(record);
    if (measure) {
      // A person does not wait, but the probe has to see the paint land.
      await sleep(1800);
      const frames = await stopCapture(app);
      record.latency = previewLatency(frames, samples, strip, t0);
    }
    return { strokeId: record.id, power: view.power, span: Math.abs(to - from) };
  };

  /** A trackpad swipe: finger phase, then momentum decaying the way macOS sends it. */
  const scroll = async (totalPx) => {
    const b = await box();
    await page.mouse.move(b.x + b.width * random.range(0.3, 0.7), b.y + b.height * random.range(0.3, 0.7));
    const sign = Math.sign(totalPx);
    let left = Math.abs(totalPx);
    let velocity = random.range(18, 40);
    let n = 0;
    const events = [];
    const t0 = Date.now();
    while (left > 1 && n < 200) {
      const delta = Math.min(left, velocity);
      events.push(page.mouse.wheel(sign * delta, (random() - 0.5) * 0.5));
      left -= delta;
      velocity = n < 12 ? velocity : Math.max(1, velocity * 0.92);
      n++;
      const wait = t0 + n * 16 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    await Promise.all(events);
    return { px: totalPx };
  };

  /** A zoom by Cmd + scroll, cursor-centred, in a burst of small steps. */
  const zoom = async (deltaPower, u) => {
    const b = await box();
    await page.mouse.move(b.x + b.width * u, b.y + b.height * random.range(0.3, 0.7));
    await page.keyboard.down("Meta");
    const events = Math.max(1, Math.round((Math.abs(deltaPower) * 100) / 15));
    const per = (-deltaPower * 100) / events;
    const sent = [];
    const t0 = Date.now();
    for (let i = 0; i < events; i++) {
      sent.push(page.mouse.wheel(0, per));
      const wait = t0 + (i + 1) * 8 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    await Promise.all(sent);
    await page.keyboard.up("Meta");
    return { deltaPower, u };
  };

  /** Goes back to a past stroke the way a person finds it: zoom out, then zoom in on it. */
  const revisit = async () => {
    const s = random.pick(report.strokes);
    const p = random.pick(s.samples.slice(2, -2).length ? s.samples.slice(2, -2) : s.samples);
    await zoom(-8, 0.5);
    await sleep(random.range(120, 400));
    const power = random.range(3, 7);
    await zoom(power, Math.max(0.03, Math.min(0.97, p.f)));
    return { stroke: s.id, f: p.f, power };
  };

  const hover = async (ms) => {
    const b = await box();
    const t = Date.now();
    let u = random.range(0.2, 0.8);
    let v = random.range(0.3, 0.7);
    while (Date.now() - t < ms) {
      u = Math.max(0.05, Math.min(0.95, u + (random() - 0.5) * 0.02));
      v = Math.max(0.1, Math.min(0.9, v + (random() - 0.5) * 0.02));
      await page.mouse.move(b.x + b.width * u, b.y + b.height * v);
      await sleep(16);
    }
    return { ms };
  };

  // The picture at full zoom-out before any paint, per row, for the thresholds.
  await gesture("zoom", () => zoom(-8, 0.5));
  await sleep(1500);
  const b0 = await box();
  const rows = Array.from({ length: 81 }, (_, i) => 0.05 + (0.9 * i) / 80);
  const baseline = await grab(
    app,
    { x: Math.round(b0.x), y: Math.round(b0.y), width: Math.round(b0.width), height: Math.round(b0.height) },
    rows,
  );
  const rowLevel = baseline.rows.map((line) => [...line].sort((a, c) => a - c)[Math.floor(line.length * 0.5)]);
  report.baselineRows = rowLevel;
  await savePng(app, join(OUT, "baseline.png"));

  /**
   * Checks every painted dab in view: its centre must read dark. A dab seen
   * dark at an earlier check and light now was undone; one painted seconds ago
   * and never seen dark is missing. Zoomed out a dab is a few pixels wide, so
   * a column reads dark if any pixel within two of its centre does.
   */
  const darkLevel = 12;
  const dabSeen = new Map();
  const storeState = new Map();
  const check = async (label, { settled = false } = {}) => {
    const b = await box();
    const view = await viewState(page, fileId);
    await page.mouse.move(b.x + b.width * 0.995, b.y + b.height * 0.995);
    await sleep(60);
    const picture = await grab(
      app,
      { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
      rows,
    );
    const dabs = await page.evaluate(
      (id) => (globalThis.__dabLog ?? []).map((d, i) => ({ ...d, i })).filter((d) => d.fileId === id),
      fileId,
    );
    const now = Date.now();
    let checked = 0;
    const light = [];
    const undone = [];
    const missing = [];
    for (const d of dabs) {
      if (d.paintedAt === null) continue;
      const u = screenFraction(d.x + d.width / 2, view);
      if (u < 0.02 || u > 0.97) continue;
      const v = 1 - (d.y + d.height / 2);
      const r = rows.reduce((best, rv, i) => (Math.abs(rv - v) < Math.abs(rows[best] - v) ? i : best), 0);
      if (Math.abs(rows[r] - v) > d.height * 0.35) continue;
      const level = rowLevel[r];
      if (level - darkLevel < 25) continue;
      const col = Math.round(u * picture.width);
      let lum = 255;
      for (let c = Math.max(0, col - 2); c <= Math.min(picture.width - 1, col + 2); c++)
        lum = Math.min(lum, picture.rows[r][c]);
      checked++;
      const dark = lum <= darkLevel + (level - darkLevel) * 0.5;
      const seen = dabSeen.get(d.i);
      const age = now - d.paintedAt;
      const entry = { dab: d.i, ageMs: age, f: d.x + d.width / 2, v: rows[r], lum, level };
      if (dark) {
        if (!seen) dabSeen.set(d.i, label);
        continue;
      }
      light.push(entry);
      if (seen) undone.push({ ...entry, seenAt: seen });
      else if (age > 3000) missing.push(entry);
    }
    const result = {
      label,
      t: now,
      power: view.power,
      offset: view.offset,
      settled,
      checked,
      light: light.length,
      undone: undone.length,
      missing: missing.length,
    };

    // The data: each painted dab's centre as the committed store holds it.
    const painted = dabs.filter((d) => d.paintedAt !== null);
    const readings = await page.evaluate(async ({ id, points }) => await globalThis.__readTruth(id, points), {
      id: fileId,
      points: painted.map((d) => ({ f: d.x + d.width / 2, p: d.y + d.height / 2 })),
    });
    const storeUndone = [];
    const storePending = [];
    let storeErased = 0;
    painted.forEach((d, k) => {
      const r = readings[k];
      const erased = r.original > 0 && r.store / r.original < 0.01;
      const was = storeState.get(d.i);
      if (erased) {
        storeErased++;
        if (!was) storeState.set(d.i, label);
        return;
      }
      const entry = {
        dab: d.i,
        ageMs: now - d.paintedAt,
        f: d.x + d.width / 2,
        pixel: r.pixel,
        ratio: r.store / r.original,
      };
      if (was) storeUndone.push({ ...entry, erasedAt: was });
      else storePending.push(entry);
    });
    Object.assign(result, {
      dabs: painted.length,
      requested: dabs.length,
      storeErased,
      storeUndone: storeUndone.length,
      storePending: storePending.length,
      storePendingOldestMs: storePending.length ? Math.max(...storePending.map((e) => e.ageMs)) : 0,
    });
    if (storeUndone.length) result.storeUndoneDabs = storeUndone.slice(0, 20);
    if (settled && storePending.length) result.storeLostDabs = storePending.slice(0, 40);
    if (undone.length || missing.length) {
      result.undoneDabs = undone.slice(0, 20);
      result.missingDabs = missing.slice(0, 20);
      if (report.checks.filter((c) => c.undone || c.missing).length < 12) {
        result.png = join(OUT, `loss-${report.checks.length}-${label}.png`);
        await savePng(app, result.png);
      }
    }
    report.checks.push(result);
    return result;
  };

  // Phase one: quick strokes across the whole file, zoomed out.
  console.log("zoomed out: strokes across the file");
  for (let i = 0; i < 8; i++) {
    const from = random.range(0.05, 0.6);
    const to = Math.min(0.95, from + random.range(0.2, 0.55));
    const flip = random() < 0.5;
    await gesture("stroke-out", () =>
      stroke({
        from: flip ? to : from,
        to: flip ? from : to,
        via: random() < 0.3 ? random.range(0.1, 0.9) : undefined,
        v: random.range(0.3, 0.7),
        durationMs: random.range(250, 700),
        measure: true,
      }),
    );
    await sleep(random.range(0, 150));
  }
  await gesture("check", () => check("after-zoomed-out"));
  for (let i = 0; i < 3; i++) {
    await gesture("revisit", () => revisit());
    await sleep(400);
    await gesture("check", () => check(`revisit-out-${i}`));
  }

  // Phase two: roam. Zoom in, scroll, paint, zoom out, the mix a session has.
  console.log(`roaming: ${GESTURES} gestures`);
  for (let i = 0; i < GESTURES; i++) {
    const view = await viewState(page, fileId);
    const r = random();
    if (view.power < 1.5 || (r < 0.12 && view.power < 5)) {
      await gesture("zoom-in", () => zoom(random.range(1.2, 2.6), random.range(0.2, 0.8)));
    } else if (r < 0.2) {
      await gesture("zoom-out", () => zoom(-random.range(0.8, 2.0), random.range(0.2, 0.8)));
    } else if (r < 0.32) {
      await gesture("revisit", () => revisit());
      await sleep(400);
      await gesture("check", () => check(`revisit-${i}`));
    } else if (r < 0.42) {
      // Back-to-back: paint, scroll on, paint, scroll back over it, paint again.
      const quick = () => {
        const from = random.range(0.15, 0.75);
        const to = Math.max(0.03, Math.min(0.97, from + (random() < 0.5 ? -1 : 1) * random.range(0.15, 0.5)));
        return stroke({ from, to, v: random.range(0.3, 0.7), durationMs: random.range(150, 400), measure: false });
      };
      const px = (random() < 0.5 ? -1 : 1) * random.range(300, 900);
      await gesture("burst", async () => {
        await quick();
        await scroll(px);
        await quick();
        await scroll(-px);
        await quick();
        return { px };
      });
      if (random() < 0.6) await gesture("check", () => check(`burst-${i}`));
    } else if (r < 0.58) {
      await gesture("scroll", () => scroll((random() < 0.5 ? -1 : 1) * random.range(200, 1400)));
      await gesture("check", () => check(`roam-${i}`));
    } else if (r < 0.92) {
      const from = random.range(0.1, 0.8);
      const to = Math.max(0.03, Math.min(0.97, from + (random() < 0.5 ? -1 : 1) * random.range(0.15, 0.6)));
      await gesture("stroke-in", () =>
        stroke({
          from,
          to,
          via: random() < 0.3 ? random.range(0.1, 0.9) : undefined,
          v: random.range(0.3, 0.7),
          durationMs: random.range(180, 550),
          measure: random() < 0.35,
        }),
      );
    } else {
      await gesture("hover", () => hover(random.range(200, 800)));
    }
    await sleep(random.range(30, 350));
    if (i % 15 === 14) {
      await gesture("zoom-out-full", () => zoom(-8, 0.5));
      await gesture("check", () => check(`full-${i}`));
    }
  }

  // The truth once every commit has landed: full zoom-out, then a close look.
  await gesture("zoom-out-full", () => zoom(-8, 0.5));
  await tag(page, "settle");
  await sleep(12000);
  await check("final-settled", { settled: true });
  await savePng(app, join(OUT, "final.png"));

  if (flag("profile")) {
    const { profile } = await cdp.send("Profiler.stop");
    writeFileSync(join(OUT, "session.cpuprofile"), JSON.stringify(profile));
    report.profileTop = summariseProfile(profile);
    stallProfile = profile;
  }

  if (flag("heap")) {
    const { profile } = await cdp.send("HeapProfiler.stopSampling");
    writeFileSync(join(OUT, "session.heapprofile"), JSON.stringify(profile));
    report.heapTop = summariseHeap(profile);
  }
  const dabLog = await page.evaluate((id) => (globalThis.__dabLog ?? []).filter((d) => d.fileId === id), fileId);
  report.dabQueue = {
    requested: dabLog.length,
    dropped: dabLog.filter((d) => d.paintedAt === null).length,
    waitMs: quantiles(dabLog.filter((d) => d.paintedAt !== null).map((d) => d.paintedAt - d.requestedAt)),
    heldOver50ms: dabLog.filter((d) => d.paintedAt !== null && d.paintedAt - d.requestedAt > 50).length,
    held: dabLog
      .filter((d) => d.paintedAt === null || d.paintedAt - d.requestedAt > 100)
      .map((d) => ({ requestedAt: d.requestedAt, paintedAt: d.paintedAt, x: d.x })),
  };
  const probes = await readProbes(page);
  const processes = await readProcessSamples(app);
  report.mainThread = mainThread;
  report.frameGaps = summariseGaps(probes);
  if (stallProfile) report.stalls = summariseStalls(stallProfile, report.profilePerfStart, probes.gaps);
  report.processes = summariseProcesses(processes);
  const busiest = Object.entries(report.processes)
    .sort((a, b) => b[1].peakMB - a[1].peakMB)[0]?.[0]
    .split(":")[1];
  report.memorySeries = processes
    .filter((p) => String(p.pid) === busiest)
    .map((p) => [p.t, Math.round(p.workingSetMB)]);
  const peak = report.memorySeries.reduce((best, sample) => (sample[1] > best[1] ? sample : best), [0, 0]);
  const during = report.gestures.filter((g) => g.start <= peak[0] + 2000 && g.start + g.wallMs >= peak[0] - 4000);
  report.memoryPeak = { t: peak[0], mb: peak[1], gestures: during.map((g) => `${g.kind}@${g.start - peak[0]}ms`) };
  const commitsNear = diagLines(logPath, /\[timing\]/).filter((l) => Math.abs(l.t - peak[0]) < 5000);
  report.memoryPeak.timing = commitsNear.map((l) => `${l.t - peak[0]}ms ${l.line.slice(24, 160)}`);
  report.diag = {
    commits: diagLines(logPath, /\[timing\]\s+commitStroke/).map((l) => l.data?.ms),
    historyAdd: diagLines(logPath, /commit history add/).map((l) => l.data?.ms),
    cadence: diagLines(logPath, /\[frame\]\s+cadence/).map((l) => l.data),
    memory: diagLines(logPath, /\[memory\]\s+renderer/).map((l) => l.data),
    warnings: diagLines(logPath, /\b(WARN|ERROR)\b/).map((l) => l.line.slice(0, 300)),
  };
  report.console = consoleLines
    .filter((c) => c.type === "error" || c.type === "warning" || c.type === "pageerror")
    .slice(0, 40);
} finally {
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
  await app.close().catch(() => {});
}

printSummary(report);
console.log(`\nreport: ${join(OUT, "report.json")}`);

/**
 * Per column of the strip: when the pointer passed it, and when the erase
 * showed there and stayed. Latency is the second minus the first.
 */
function previewLatency(frames, samples, strip, t0) {
  if (frames.length < 3) return { frames: frames.length };
  const width = frames[0].columns.length;
  const before = frames.filter((f) => f.done < t0);
  if (!before.length) return { frames: frames.length, note: "no frame before the stroke" };
  const base = Array.from({ length: width }, (_, c) => Math.max(...before.map((f) => f.columns[c])));
  const after = frames.filter((f) => f.t >= t0);
  const passTime = (x) => {
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1].x;
      const c = samples[i].x;
      if ((a - x) * (c - x) <= 0) return samples[i].t;
    }
    return null;
  };
  const latencies = [];
  let never = 0;
  const margin = Math.round(width * 0.03);
  for (let c = margin; c < width - margin; c += 2) {
    const x = strip.x + ((c + 0.5) / width) * strip.width;
    const tp = passTime(x);
    if (tp === null || base[c] < 50) continue;
    const dark = (f) => f.columns[c] < base[c] * 0.55;
    let settledAt = null;
    for (let i = after.length - 1; i >= 0; i--) {
      if (!dark(after[i])) break;
      settledAt = after[i].t;
    }
    if (settledAt === null) never++;
    else latencies.push(Math.max(0, settledAt - tp));
  }
  const intervals = after.slice(1).map((f, i) => f.t - after[i].t);
  return { ...quantiles(latencies), never, captureMs: quantiles(intervals).p50 };
}

function summariseGaps(probes) {
  const byGesture = {};
  for (const gap of probes.gaps) (byGesture[gap.gesture] ??= []).push(gap.ms);
  const frames = {};
  for (const [, ms, g] of probes.frameMs) (frames[g] ??= []).push(ms);
  const out = {};
  for (const g of new Set([...Object.keys(frames), ...Object.keys(byGesture)])) {
    const all = frames[g] ?? [];
    const gaps = byGesture[g] ?? [];
    out[g] = {
      frames: all.length,
      over50: all.filter((m) => m > 50).length,
      over100: all.filter((m) => m > 100).length,
      frame: quantiles(all),
      gaps: quantiles(gaps),
    };
  }
  const tasks = {};
  for (const t of probes.longTasks) (tasks[t.gesture] ??= []).push(t.ms);
  out.longTasks = Object.fromEntries(Object.entries(tasks).map(([g, v]) => [g, quantiles(v)]));
  return out;
}

function summariseProcesses(samples) {
  const byPid = new Map();
  for (const s of samples) {
    const e = byPid.get(s.pid) ?? { type: s.type, first: s, last: s, peakMB: 0 };
    e.last = s;
    e.peakMB = Math.max(e.peakMB, s.workingSetMB);
    byPid.set(s.pid, e);
  }
  const out = {};
  for (const [pid, e] of byPid) {
    const seconds = (e.last.t - e.first.t) / 1000;
    const cpu = e.last.cpuSec - e.first.cpuSec;
    out[`${e.type}:${pid}`] = {
      cpuSec: Math.round(cpu * 10) / 10,
      cpuPercent: seconds > 0 ? Math.round((cpu / seconds) * 1000) / 10 : 0,
      peakMB: Math.round(e.peakMB),
      endMB: Math.round(e.last.workingSetMB),
    };
  }
  return out;
}

function summariseProfile(profile) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = (profile.endTime - profile.startTime) / 1000 / Math.max(1, profile.samples.length);
  for (const id of profile.samples) {
    const node = byId.get(id);
    const f = node.callFrame;
    const key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([k, ms]) => `${Math.round(ms)} ms  ${k}`);
}

/** Bytes allocated over the session by allocating stack (top frames), largest first. */
function summariseHeap(profile) {
  const totals = new Map();
  const walk = (node, stack) => {
    const f = node.callFrame;
    const here = [...stack, `${f.functionName || "(anon)"}:${f.url.split("/").pop()}:${f.lineNumber + 1}`];
    const self = node.selfSize;
    if (self > 0) {
      const key = here.slice(-5).reverse().join(" < ");
      totals.set(key, (totals.get(key) ?? 0) + self);
    }
    for (const child of node.children ?? []) walk(child, here);
  };
  walk(profile.head, []);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([k, bytes]) => `${Math.round(bytes / 1048576)} MB  ${k}`);
}

/** Self time by function inside every frame gap over 50 ms, and the gaps themselves. */
function summariseStalls(profile, perfStart, gaps) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const times = [];
  let t = profile.startTime;
  for (const delta of profile.timeDeltas) {
    t += delta;
    times.push(perfStart + (t - profile.startTime) / 1000);
  }
  const stalls = gaps.filter((g) => g.ms > 50);
  const self = new Map();
  const list = [];
  for (const gap of stalls) {
    const end = gap.p;
    const start = end - gap.ms;
    const mine = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      if (times[i] < start || times[i] > end) continue;
      const f = byId.get(profile.samples[i]).callFrame;
      const key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
      const dt = (i + 1 < times.length ? times[i + 1] : times[i]) - times[i];
      self.set(key, (self.get(key) ?? 0) + dt);
      mine.set(key, (mine.get(key) ?? 0) + dt);
    }
    const top = [...mine.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, ms]) => `${Math.round(ms)} ${k}`);
    list.push({ ms: Math.round(gap.ms), gesture: gap.gesture, top });
  }
  return {
    top: [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([k, ms]) => `${Math.round(ms)} ms  ${k}`),
    list: list.sort((a, b) => b.ms - a.ms).slice(0, 25),
  };
}

function printSummary(r) {
  console.log(
    `\n== ${r.seconds} s file, ${r.extra} others, window ${r.windowBlocks} blocks, open ${((r.openMs ?? 0) / 1000).toFixed(1)} s`,
  );
  console.log("\nframes by gesture (rAF interval ms):");
  for (const [g, s] of Object.entries(r.frameGaps ?? {})) {
    if (g === "longTasks") continue;
    console.log(
      `  ${g.padEnd(14)} n=${String(s.frames).padStart(5)} p50=${s.frame.p50} p90=${s.frame.p90} p99=${s.frame.p99} max=${s.frame.max}  >50ms=${s.over50} >100ms=${s.over100}`,
    );
  }
  console.log("\nmain thread busy by gesture:");
  for (const [g, m] of Object.entries(r.mainThread ?? {}))
    console.log(
      `  ${g.padEnd(14)} ${Math.round((100 * m.taskMs) / Math.max(1, m.wallMs))}% of ${Math.round(m.wallMs)} ms (script ${Math.round(m.scriptMs)} ms), ${m.count}×`,
    );
  const lat = r.strokes.filter((s) => s.latency?.n);
  console.log("\npreview latency (ms from pointer pass to erase shown):");
  for (const s of lat)
    console.log(
      `  stroke ${String(s.id).padStart(2)} zoom ${s.power.toFixed(1)}  p50=${s.latency.p50} p90=${s.latency.p90} max=${s.latency.max} never=${s.latency.never} (capture ${s.latency.captureMs} ms)`,
    );
  console.log("\npaint checks:");
  for (const c of r.checks)
    console.log(
      `  ${c.label.padEnd(16)} zoom ${c.power.toFixed(1)} screen: checked=${c.checked} light=${c.light} undone=${c.undone} missing=${c.missing}` +
        ` | store: dabs=${c.dabs} erased=${c.storeErased} undone=${c.storeUndone} pending=${c.storePending} (oldest ${c.storePendingOldestMs} ms)`,
    );
  if (r.dabQueue)
    console.log(
      `\ndab queue: ${r.dabQueue.requested} requested, ${r.dabQueue.dropped} never painted, wait ${JSON.stringify(r.dabQueue.waitMs)}, ${r.dabQueue.heldOver50ms} held > 50 ms`,
    );
  if (r.memoryPeak) {
    console.log(`\nmemory peak ${r.memoryPeak.mb} MB during ${r.memoryPeak.gestures.join(", ")}`);
    for (const line of r.memoryPeak.timing.slice(0, 20)) console.log(`  ${line}`);
  }
  console.log("\nprocesses:");
  for (const [k, p] of Object.entries(r.processes ?? {}))
    console.log(`  ${k.padEnd(18)} cpu ${p.cpuSec}s (${p.cpuPercent}%) peak ${p.peakMB} MB end ${p.endMB} MB`);
  const commits = (r.diag?.commits ?? []).filter((x) => typeof x === "number");
  console.log(`\ncommits: ${JSON.stringify(quantiles(commits))}`);
  console.log(`warnings: ${(r.diag?.warnings ?? []).length}, console errors: ${(r.console ?? []).length}`);
  for (const w of (r.diag?.warnings ?? []).slice(0, 8)) console.log(`  ${w}`);
  for (const c of (r.console ?? []).slice(0, 8)) console.log(`  ${c.type}: ${c.text.slice(0, 200)}`);
  if (r.stalls) {
    console.log("\nwhat runs inside frame gaps over 50 ms (self time):");
    for (const line of r.stalls.top.slice(0, 20)) console.log(`  ${line}`);
    console.log("\nworst gaps:");
    for (const g of r.stalls.list.slice(0, 15)) console.log(`  ${g.ms} ms in ${g.gesture}: ${g.top.join(" | ")}`);
  }
  if (r.heapTop) {
    console.log("\nallocations over the session (sampled):");
    for (const line of r.heapTop.slice(0, 25)) console.log(`  ${line}`);
  }
  if (r.profileTop) {
    console.log("\nCPU profile, self time:");
    for (const line of r.profileTop.slice(0, 25)) console.log(`  ${line}`);
  }
}
