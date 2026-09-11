// Checks that a canvas holding a window of the file paints what a canvas
// holding all of it paints.
//
// The unit suite cannot see this class of fault: it compares two renderers,
// and both can be fed the same empty canvas. So this drives the real app
// twice — once whole-file, once with an eight-block window — over the same
// actions, and compares the picture and the committed footprint.
//
// Usage: node scripts/window-check.mjs [blocks]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { _electron } = createRequire(join(root, "package.json"))("playwright");
const footprintModule = buildSync({
  entryPoints: [join(root, "scripts/window-check-footprint.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
}).outputFiles[0].text;
const { fixture, scriptedPositions, committedFootprints, expectedStrokeSpan } = await import(
  `data:text/javascript;base64,${Buffer.from(footprintModule).toString("base64")}`
);

const inputModule = buildSync({
  entryPoints: [join(root, "scripts/window-check-input.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
}).outputFiles[0].text;
const { installInputMonitor, runCleanLeg, cleanStrokeFailures } = await import(
  `data:text/javascript;base64,${Buffer.from(inputModule).toString("base64")}`
);

const blocks = process.argv[2] ?? "8";
const SECONDS = fixture.seconds;
const SAMPLE_RATE = fixture.sampleRate;

/** A tone long enough to need many blocks, written where the app can open it. */
function writeTone(path) {
  const frames = SECONDS * SAMPLE_RATE;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const value = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 660 * t);
    bytes.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  writeFileSync(path, bytes);
}

/** The brightest channel of each column of `rect`, read out of a screenshot. */
async function columnBrightness(app, page, rect) {
  const shot = await app.evaluate(async ({ BrowserWindow }) => {
    const picture = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return picture.toPNG().toString("base64");
  });
  return await page.evaluate(
    async ({ data, box }) =>
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onerror = () => reject(new Error("the screenshot did not decode"));
        image.onload = () => {
          const scale = image.width / window.innerWidth;
          const x = Math.round(box.x * scale);
          const y = Math.round(box.y * scale);
          const w = Math.round(box.width * scale);
          const h = Math.round(box.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, x, y, w, h, 0, 0, w, h);
          const pixels = ctx.getImageData(0, 0, w, h).data;
          const columns = [];
          for (let px = 0; px < w; px++) {
            let brightest = 0;
            for (let py = 0; py < h; py++) {
              const i = (py * w + px) * 4;
              brightest = Math.max(brightest, pixels[i], pixels[i + 1], pixels[i + 2]);
            }
            columns.push(brightest);
          }
          resolve(columns);
        };
        image.src = `data:image/png;base64,${data}`;
      }),
    { data: shot, box: rect },
  );
}

async function proveInputOrigin(page, monitor, box, origin) {
  const cover = await page.evaluateHandle(() => {
    const element = document.createElement("div");
    element.style.cssText = "position:fixed;inset:0;z-index:2147483647";
    document.body.append(element);
    return element;
  });
  try {
    await monitor.evaluate((input) => input.begin());
    const y = box.y + box.height * 0.45;
    const points = scriptedPositions.map((position) => ({ x: box.x + box.width * position, y }));
    await page.mouse.move(points[0].x, y);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(point.x, y);
    await cover.evaluate(
      (element, { origin, point }) => {
        const init = {
          bubbles: true,
          buttons: 0,
          clientX: Math.floor(point.x),
          clientY: Math.floor(point.y),
          screenX: Math.floor(point.x) + origin.x,
          screenY: Math.floor(point.y) + origin.y,
        };
        element.dispatchEvent(new PointerEvent("pointermove", init));
        element.dispatchEvent(new MouseEvent("mousemove", init));
      },
      { origin, point: points.at(-1) },
    );
    await page.mouse.up();
    await monitor.evaluate((input) => input.end());
    const records = await monitor.evaluate((input) => input.read());
    const expected = [];
    const pair = (action, point, buttons) => {
      for (const prefix of ["pointer", "mouse"]) expected.push({ type: prefix + action, ...point, buttons });
    };
    pair("move", points[0], 0);
    pair("down", points[0], 1);
    for (const point of points.slice(1)) pair("move", point, 1);
    pair("up", points.at(-1), 0);
    const scripted = records.filter(
      (event) => event.origin === "scripted" && /^(pointer|mouse)(move|down|up)$/.test(event.type),
    );
    if (
      scripted.length !== expected.length ||
      expected.some((event, i) => {
        const actual = scripted[i];
        return (
          actual.type !== event.type ||
          actual.buttons !== event.buttons ||
          !actual.isTrusted ||
          Math.abs(actual.clientX - event.x) >= 1 ||
          Math.abs(actual.clientY - event.y) >= 1
        );
      })
    ) {
      throw new Error(`the input discriminator did not recognise the scripted path: ${JSON.stringify(records)}`);
    }
    const injected = records.filter((event) => !event.isTrusted);
    if (injected.length !== 2 || injected.some((event) => event.origin !== "native" || !event.duringStroke)) {
      throw new Error(`the input discriminator missed the injected native-looking moves: ${JSON.stringify(injected)}`);
    }
    console.log(
      `input proof: ${scripted.length} scripted events recognised; two injected native-looking moves detected at content origin (${origin.x}, ${origin.y}).`,
    );
  } finally {
    await page.mouse.up();
    await monitor.evaluate((input) => input.end());
    await cover.evaluate((element) => element.remove());
    await cover.dispose();
  }
}

async function run(label, windowBlocks, wav) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // 0 pins the whole file on the canvas; without it the budget would pick a
  // window for the reference run too, and the two runs would compare nothing.
  env.VITE_CANVAS_WINDOW_BLOCKS = String(windowBlocks || 0);

  process.stdout.write(`${label}: building… `);
  execFileSync("npx", ["electron-vite", "build"], { cwd: root, env, stdio: "pipe" });
  process.stdout.write("built.\n");
  const result = await runCleanLeg(
    label,
    (attempt) => runAttempt(`${label}, attempt ${attempt}`, wav, env),
    console.log,
  );
  const failures = cleanStrokeFailures(result.footprints);
  for (const error of result.errors) failures.push(`console: ${error}`);
  if (failures.length) throw new Error(`${label}: ${failures.join("\n")}`);
  return result;
}

async function runAttempt(label, wav, env) {
  process.stdout.write(`${label}: opening… `);
  const profile = mkdtempSync(join(tmpdir(), "nc-window-check-"));
  const app = await _electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root, env });
  try {
    const page = await app.firstWindow();
    const logs = [];
    const errors = [];
    page.on("console", (message) => {
      logs.push(message.text());
      if (message.type() === "error" && !/HRTF/.test(message.text())) errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(4000);
    const noThanks = page.getByText("No thanks", { exact: false });
    if (await noThanks.count())
      await noThanks
        .first()
        .click()
        .catch(() => {});

    await app.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0].webContents.send("open-file", path);
    }, wav);
    await page.waitForSelector("[data-file-view-id]", { timeout: 300000 });
    await page.waitForTimeout(20000);

    const box = await page.locator("[data-file-view-id]").first().boundingBox();
    if (!box) throw new Error("no file view to paint on");
    const strip = {
      x: box.x + box.width * 0.05,
      y: box.y + box.height * 0.2,
      width: box.width * 0.9,
      height: box.height * 0.6,
    };

    const origin = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
    if (origin.x === 0 && origin.y === 0)
      throw new Error("the content window is at the screen origin; native and scripted input cannot be distinguished");
    const monitor = await page.evaluateHandle(installInputMonitor);
    await proveInputOrigin(page, monitor, box, origin);
    process.stdout.write(`${label}: painting… `);
    // A drag across most of the file, so the window has to slide several times.
    // The frame loop paints the cursor's position once per frame, so the steps
    // are spaced wider than the slowest build's dab and both paint the same set.
    const y = box.y + box.height * 0.45;
    const from = scriptedPositions[0];
    await page.mouse.move(box.x + box.width * from, y);
    await page.waitForTimeout(3000);
    await monitor.evaluate((input) => input.begin());
    await page.mouse.down();
    for (const position of scriptedPositions.slice(1, -1)) {
      await page.mouse.move(box.x + box.width * position, y);
      await page.waitForTimeout(400);
    }
    // A last dab back at the start, on a block the window has long left behind.
    // It has to wait for the read, so a window that drops a waiting dab commits
    // a shorter stroke than the whole file does.
    await page.mouse.move(box.x + box.width * scriptedPositions.at(-1), y);
    await page.waitForTimeout(400);
    await page.mouse.up();
    await monitor.evaluate((input) => input.end());
    const input = await monitor.evaluate((input) => input.read());
    await monitor.evaluate((input) => input.dispose());
    await monitor.dispose();
    const finalOrigin = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
    if (
      (origin.x !== finalOrigin.x || origin.y !== finalOrigin.y) &&
      !input.some((event) => event.duringStroke && event.origin === "native")
    )
      throw new Error("the content window moved during the stroke; the input discriminator could not be verified");
    await page.waitForTimeout(20000);
    // Off the spectrogram, so no brush overlay lands in the picture.
    await page.mouse.move(box.x + box.width * 0.2, box.y - 40);
    await page.waitForTimeout(3000);

    const columns = await columnBrightness(app, page, strip);
    const residentMB = await page.evaluate(async () =>
      Math.round((await process.getProcessMemoryInfo()).private / 1024),
    );
    const footprints = committedFootprints(logs);

    process.stdout.write(`${residentMB} MB\n`);
    for (const footprint of footprints) {
      console.log(`${label}: ${footprint.line}`);
      console.log(
        `${label}: committed time bounds ${JSON.stringify(footprint.bounds)}; expected span ${JSON.stringify(expectedStrokeSpan())}`,
      );
    }
    return { columns, footprints, errors, residentMB, input };
  } finally {
    await app.close();
  }
}

const wav = join(mkdtempSync(join(tmpdir(), "nc-window-audio-")), "tone.wav");
writeTone(wav);

function fail(error) {
  console.error(`\nFAILED\n${error.message}`);
  process.exit(1);
}

const whole = await run("whole file", null, wav).catch(fail);
const windowed = await run(`${blocks} blocks`, blocks, wav).catch(fail);

const failures = [];
if (whole.columns.length !== windowed.columns.length) {
  failures.push(`the two runs measured different widths (${whole.columns.length} vs ${windowed.columns.length})`);
} else {
  // A hole: the whole-file canvas shows content there and the windowed one is black.
  const holes = whole.columns.filter((bright, i) => bright > 60 && windowed.columns[i] < 40).length;
  if (holes > 0) failures.push(`${holes} columns of the picture went black under the window`);
}

const describe = (footprint) => (footprint ? `${footprint.ranges} ranges / ${footprint.pixels} pixels` : "none");

const wholeFootprint = whole.footprints.length === 1 ? whole.footprints[0] : null;
const windowedFootprint = windowed.footprints.length === 1 ? windowed.footprints[0] : null;

if (wholeFootprint && windowedFootprint) {
  if (wholeFootprint.ranges !== windowedFootprint.ranges) {
    failures.push(`the commit covers different bands: ${describe(wholeFootprint)} vs ${describe(windowedFootprint)}`);
  }
  // The footprint's time edge rounds up to a whole bin against the band's own
  // bin count, and a band's count over the file is itself rounded up, so the
  // two runs can land a bin apart at an edge. The four-bin margin either side
  // covers it; a wider gap is real paint the commit missed.
  const slack = wholeFootprint.ranges;
  const gap = Math.abs(wholeFootprint.pixels - windowedFootprint.pixels);
  if (gap > slack) {
    failures.push(`the commit differs by ${gap} pixels: ${describe(wholeFootprint)} vs ${describe(windowedFootprint)}`);
  }
}

console.log(`\ncommitted   whole file: ${describe(wholeFootprint)}`);
console.log(`            windowed:   ${describe(windowedFootprint)}`);
console.log(`resident    whole file: ${whole.residentMB} MB, windowed: ${windowed.residentMB} MB`);

if (failures.length > 0) {
  console.error(`\nFAILED\n${failures.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}
console.log("\nOK. The window paints what the whole file paints.");
