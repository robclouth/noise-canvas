// Launches the built app in an isolated profile and drives it the way a person
// does: quick strokes, trackpad scrolls and zooms, with no waits for the
// picture to catch up. Everything here measures the real app, not the suite.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { _electron } = createRequire(join(root, "package.json"))("playwright");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A seeded generator, so a session can be replayed gesture for gesture. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.pick = (items) => items[Math.floor(next() * items.length)];
  return next;
}

/** Builds the app with the store exposed to the driver. Returns the launch env. */
export function build({ windowBlocks, skip } = {}) {
  const env = { ...process.env, VITE_DEBUG_GLOBALS: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  if (windowBlocks !== undefined) env.VITE_CANVAS_WINDOW_BLOCKS = String(windowBlocks);
  if (!skip) {
    process.stdout.write("building… ");
    execFileSync("npx", ["electron-vite", "build"], { cwd: root, env, stdio: "pipe" });
    process.stdout.write("built.\n");
  }
  return env;
}

/**
 * Writes stereo white noise, so the whole spectrogram is lit and an erased
 * stroke reads as a black cut through it.
 */
export function writeNoise(path, seconds, seed = 1, sampleRate = 44100) {
  if (existsSync(path)) return path;
  const random = rng(seed);
  const frames = Math.round(seconds * sampleRate);
  const bytes = Buffer.alloc(44 + frames * 4);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + frames * 4, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames * 2; i++) bytes.writeInt16LE(Math.round((random() * 2 - 1) * 0.3 * 32767), 44 + i * 2);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/**
 * Closes the app and removes its profile, which holds every opened file's
 * block store. The log is kept beside where the profile was, as `<profile>.log`.
 */
export async function closeApp(app, profile) {
  await app.close().catch(() => {});
  const log = join(profile, "logs", "noise-canvas.log");
  if (existsSync(log)) copyFileSync(log, `${profile}.log`);
  rmSync(profile, { recursive: true, force: true });
}

/** Launches the built app at the given window size, in a fresh profile or in `profile` to relaunch one. */
export async function launch(env, { width = 1600, height = 1172, profile: reuse } = {}) {
  const profile = reuse ?? mkdtempSync(join(tmpdir(), "noisecanvas-drive-"));
  const app = await _electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root, env });
  const page = await app.firstWindow();
  const console_ = [];
  page.on("console", (message) => console_.push({ t: Date.now(), type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => console_.push({ t: Date.now(), type: "pageerror", text: error.message }));
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setBounds({ x: 80, y: 40, width: size.width, height: size.height });
    },
    { width, height },
  );
  await page.waitForFunction(() => !document.querySelector(".mantine-LoadingOverlay-root"), null, {
    timeout: 300000,
  });
  await sleep(2500);
  const noThanks = page.getByText("No thanks", { exact: false });
  if (await noThanks.count())
    await noThanks
      .first()
      .click()
      .catch(() => {});
  const logPath = join(profile, "logs", "noise-canvas.log");
  return { app, page, profile, console: console_, logPath };
}

/** Opens each path in turn, as File → Open does, and waits until every view has mounted. */
export async function openFiles(app, page, paths, { timeoutMs = 600000 } = {}) {
  for (const path of paths) {
    const before = await page.locator("[data-file-view-id]").count();
    await app.evaluate(
      ({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send("open-file", p),
      path,
    );
    await page.waitForFunction((n) => document.querySelectorAll("[data-file-view-id]").length > n, before, {
      timeout: timeoutMs,
    });
  }
}

/** Puts one Dynamics step at −80 dB on the active brush, so a stroke erases and shows as dark. */
export async function seedEraseBrush(page, { size } = {}) {
  await page.evaluate((size) => {
    const store = globalThis.__store;
    if (!store) throw new Error("the build does not expose the store (VITE_DEBUG_GLOBALS)");
    const state = store.getState();
    state.setParameter("effects", [
      { id: "drive-erase", effect: "dynamics", enabled: true, params: { dynamicsGainDb: -80 } },
    ]);
    if (size !== undefined) state.setParameter("brushSizePitch", size);
  }, size);
  const effects = await page.evaluate(() => {
    const state = globalThis.__store.getState();
    const step = state.brushes[state.activeBrushIndex]?.steps?.[state.activeStepIndex];
    return JSON.stringify(step?.effects ?? null);
  });
  if (!effects || !effects.includes("dynamics")) throw new Error(`the erase brush did not take: ${effects}`);
}

/** The file view whose id carries the given file, or the newest one. */
export async function viewOf(page, fileId) {
  return await page.evaluate((fileId) => {
    const views = [...document.querySelectorAll("[data-file-view-id]")];
    const view = fileId ? views.find((v) => v.getAttribute("data-file-view-id") === fileId) : views[0];
    if (!view) return null;
    const r = view.getBoundingClientRect();
    return { id: view.getAttribute("data-file-view-id"), x: r.x, y: r.y, width: r.width, height: r.height };
  }, fileId);
}

/** The view's zoom power and offset, and the file's duration, from the store. */
export async function viewState(page, fileId) {
  return await page.evaluate((fileId) => {
    const state = globalThis.__store.getState();
    const file = state.openFiles?.[fileId];
    return {
      power: state.filesZoom[fileId] ?? 0,
      offset: state.filesOffset[fileId] ?? 0,
      numFrames: file?.spectrogramData?.numFrames ?? null,
    };
  }, fileId);
}

/** File fraction under screen fraction `u` for a view at zoom `power`, offset `offset`. */
export function fileFraction(u, { power, offset }) {
  const z = Math.pow(2, power);
  const width = 1 / z;
  const start = z > 1 ? offset * (1 - width) : 0;
  return start + u * width;
}

/** Screen fraction for file fraction `f`, the inverse of `fileFraction`. */
export function screenFraction(f, { power, offset }) {
  const z = Math.pow(2, power);
  const width = 1 / z;
  const start = z > 1 ? offset * (1 - width) : 0;
  return (f - start) / width;
}

/**
 * Installs the in-page probes: every requestAnimationFrame gap over 34 ms and
 * every long task, each tagged with the gesture under way.
 */
export async function installProbes(page) {
  await page.evaluate(() => {
    const probe = { gesture: "idle", gaps: [], longTasks: [], frames: 0, frameMs: [] };
    globalThis.__drive = probe;
    let last = performance.now();
    const tick = (now) => {
      const gap = now - last;
      last = now;
      probe.frames++;
      probe.frameMs.push([Date.now(), gap, probe.gesture]);
      if (probe.frameMs.length > 200000) probe.frameMs.splice(0, 100000);
      if (gap > 34) probe.gaps.push({ t: Date.now(), p: now, ms: gap, gesture: probe.gesture });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          probe.longTasks.push({
            t: performance.timeOrigin + entry.startTime,
            ms: entry.duration,
            gesture: probe.gesture,
          });
      }).observe({ type: "longtask", buffered: false });
    } catch {
      // Long-task timing is optional; the frame gaps carry the figure.
    }
  });
}

export async function tag(page, gesture) {
  await page.evaluate((g) => {
    globalThis.__drive.gesture = g;
  }, gesture);
}

export async function readProbes(page) {
  return await page.evaluate(() => {
    const p = globalThis.__drive;
    const out = { gaps: p.gaps, longTasks: p.longTasks, frames: p.frames, frameMs: p.frameMs };
    p.gaps = [];
    p.longTasks = [];
    p.frameMs = [];
    return out;
  });
}

/**
 * Samples CPU time and memory of every app process every `intervalMs`, from
 * the main process's own metrics. CPU is the delta of cumulative CPU seconds.
 */
export async function startProcessSampler(app, intervalMs = 500) {
  await app.evaluate(({ app: electronApp }, interval) => {
    const samples = [];
    globalThis.__driveSamples = samples;
    const take = () => {
      const now = Date.now();
      for (const metric of electronApp.getAppMetrics()) {
        samples.push({
          t: now,
          pid: metric.pid,
          type: metric.type,
          cpuSec: metric.cpu.cumulativeCPUUsage ?? 0,
          workingSetMB: Math.round((metric.memory.workingSetSize / 1024) * 10) / 10,
          peakMB: Math.round(((metric.memory.peakWorkingSetSize ?? 0) / 1024) * 10) / 10,
          privateMB: Math.round(((metric.memory.privateBytes ?? 0) / 1024) * 10) / 10,
        });
      }
    };
    take();
    globalThis.__driveSampler = setInterval(take, interval);
  }, intervalMs);
}

export async function readProcessSamples(app) {
  return await app.evaluate(() => {
    const out = globalThis.__driveSamples.splice(0);
    return out;
  });
}

export async function stopProcessSampler(app) {
  await app.evaluate(() => clearInterval(globalThis.__driveSampler));
}

/**
 * Starts capturing the rows `rect` covers (DIP, window coordinates) as fast as
 * the compositor gives them, in the main process, keeping each column's mean
 * luminance. `stopCapture` returns the frames.
 */
export async function startCapture(app, rect) {
  await app.evaluate(({ BrowserWindow }, rect) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const state = { frames: [], running: true };
    globalThis.__driveCapture = state;
    (async () => {
      while (state.running) {
        const t = Date.now();
        const image = await contents.capturePage(rect);
        const { width, height } = image.getSize();
        const bitmap = image.toBitmap();
        const columns = new Array(width);
        for (let x = 0; x < width; x++) {
          let sum = 0;
          for (let y = 0; y < height; y++) {
            const i = (y * width + x) * 4;
            sum += 0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2];
          }
          columns[x] = Math.round(sum / Math.max(1, height));
        }
        state.frames.push({ t, done: Date.now(), columns });
      }
    })();
  }, rect);
}

export async function stopCapture(app) {
  return await app.evaluate(async () => {
    const state = globalThis.__driveCapture;
    state.running = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    return state.frames;
  });
}

/** One grab of `rect`: per-row, per-column luminance, `rows` rows sampled evenly. */
export async function grab(app, rect, rows) {
  return await app.evaluate(
    async ({ BrowserWindow }, { rect, rows }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect);
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      const out = [];
      for (const fraction of rows) {
        const y0 = Math.max(0, Math.min(height - 1, Math.round(fraction * height)));
        const line = new Array(width);
        for (let x = 0; x < width; x++) {
          let sum = 0;
          let n = 0;
          for (let dy = -2; dy <= 2; dy++) {
            const y = Math.max(0, Math.min(height - 1, y0 + dy));
            const i = (y * width + x) * 4;
            sum += 0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2];
            n++;
          }
          line[x] = Math.round(sum / n);
        }
        out.push(line);
      }
      return { width, height, rows: out };
    },
    { rect, rows },
  );
}

export async function savePng(app, path) {
  const data = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"),
  );
  writeFileSync(path, Buffer.from(data, "base64"));
}

/** The app's own diag lines of one kind from its log file, parsed. */
export function diagLines(logPath, pattern) {
  if (!existsSync(logPath)) return [];
  const out = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!pattern.test(line)) continue;
    const brace = line.indexOf("{");
    let data = null;
    try {
      data = brace >= 0 ? JSON.parse(line.slice(brace)) : null;
    } catch {
      data = null;
    }
    out.push({ t: Date.parse(line.slice(0, 24)), line, data });
  }
  return out;
}

export function quantiles(values) {
  if (!values.length) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  const round = (v) => Math.round(v * 10) / 10;
  return { n: sorted.length, p50: round(q(0.5)), p90: round(q(0.9)), p99: round(q(0.99)), max: round(sorted.at(-1)) };
}
