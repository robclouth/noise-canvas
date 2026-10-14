// The actions on a file with layers, in the built app.
//
// On a long file (the canvas holds a window of it): add a layer and paint it,
// save and check the written audio is the sum of both layers, remove the second
// layer and undo, remove the first layer and undo.
//
// On shorter files, since several must fit in graphics memory at once: add
// another file as a layer, undo and redo it, copy the layers out to files, and
// duplicate the file with its layers.
//
// Usage: node scripts/drive/probe-layer-actions.mjs [--seconds 285] [--short 120] [--no-build] [--log keep.log]
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, closeApp, diagLines, launch, openFiles, sleep, viewOf, writeNoise } from "./app.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SECONDS = Number(option("seconds", 285));
const SHORT = Number(option("short", 120));

const audioDir = join(tmpdir(), "noisecanvas-noise");
const copyOf = (seconds, seed, tag) => {
  const path = join(audioDir, `${tag}-${seconds}s-${process.pid}.wav`);
  copyFileSync(writeNoise(join(audioDir, `long-${seconds}s-seed${seed}.wav`), seconds, seed), path);
  return path;
};

const points = [];
for (let i = 0; i < 200; i++) points.push({ f: 0.05 + (0.9 * i) / 199, p: 0.15 + (0.7 * ((i * 37) % 100)) / 100 });

let failed = false;
const fail = (message) => {
  failed = true;
  console.log(`FAIL ${message}`);
};

/** The channels of a WAV file, as floats, whatever its sample format. */
function readWav(path) {
  const bytes = readFileSync(path);
  let offset = 12;
  let format = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        code: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      };
      if (format.code === 0xfffe) format.code = bytes.readUInt16LE(body + 24);
    } else if (id === "data" && format) {
      const width = format.bits / 8;
      const frames = Math.floor(size / (width * format.channels));
      const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let ch = 0; ch < format.channels; ch++) {
          const at = body + (i * format.channels + ch) * width;
          let value;
          if (format.code === 3) value = width === 4 ? bytes.readFloatLE(at) : bytes.readDoubleLE(at);
          else if (width === 2) value = bytes.readInt16LE(at) / 32768;
          else if (width === 3) value = bytes.readIntLE(at, 3) / 8388608;
          else value = bytes.readInt32LE(at) / 2147483648;
          channels[ch][i] = value;
        }
      }
      return { channels, sampleRate: format.sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`no audio in ${path}`);
}

function wavEnergy({ channels, sampleRate }, spans) {
  return spans.map(([start, end]) => {
    let sum = 0;
    for (const samples of channels) {
      for (let i = Math.floor(start * sampleRate); i < Math.min(samples.length, Math.ceil(end * sampleRate)); i++)
        sum += samples[i] * samples[i];
    }
    return sum;
  });
}

/** Helpers bound to one running app. */
function driver(app, page, logPath) {
  const state = () =>
    page.evaluate(() => {
      const s = globalThis.__store.getState();
      return {
        active: s.activeFileId,
        open: s.openFileIds,
        detached: Object.keys(s.detachedLayers),
        names: s.layerNames,
        stacks: Object.values(s.layerStacks).map((stack) => ({ owner: stack.ownerId, layers: stack.layerIds })),
        busy: s.openFileIds.filter((id) => s.filesBusy[id] || s.filesLoading[id] || s.filesSynthesizing[id]),
      };
    });
  const settle = async () => {
    await sleep(1000);
    for (let i = 0; i < 1200 && (await state()).busy.length > 0; i++) await sleep(250);
  };
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
  const waitUntil = async (test, label, tries = 1200) => {
    for (let i = 0; i < tries; i++) {
      if (test(await state())) return true;
      await sleep(100);
    }
    fail(label);
    return false;
  };
  const send = (channel) =>
    app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send(c), channel);
  const store = (fn, ...rest) => page.evaluate(fn, ...rest);
  const stroke = async (id, y0) => {
    await settle();
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
    for (let i = 0; i < 480; i++) {
      if (diagLines(logPath, /commit history add/).filter((l) => l.t >= t).length > 0) return sleep(800);
      await sleep(250);
    }
    throw new Error("the stroke never committed");
  };
  return { state, settle, read, differing, waitFor, waitUntil, send, store, stroke };
}

const env = build({ skip: args.includes("--no-build") });

console.log(`long file, ${SECONDS} s:`);
{
  const longPath = copyOf(SECONDS, 7, "save");
  const { app, page, profile, logPath } = await launch(env);
  const d = driver(app, page, logPath);
  try {
    await openFiles(app, page, [longPath]);
    const owner = (await viewOf(page)).id;
    await d.settle();
    const ownerStart = await d.read(owner);

    await d.store((id) => globalThis.__store.getState().addEmptyLayer(id), owner);
    await d.waitUntil((s) => s.open.length === 2, "the layer never appeared");
    const layer = (await d.state()).open.find((id) => id !== owner);
    await d.settle();
    await d.store(() =>
      globalThis.__store
        .getState()
        .setParameter("effects", [{ id: "drive-synth", effect: "synthesize", enabled: true, params: {} }]),
    );
    await d.stroke(layer, 0.5);
    await d.settle();
    const layerPainted = await d.read(layer);

    // Save writes the sum of both layers over the file on disk.
    const spans = Array.from({ length: 12 }, (_, i) => [(SECONDS * i) / 12, (SECONDS * (i + 1)) / 12]);
    const mix = await d.store(({ ids, spans }) => globalThis.__readAudioEnergy(ids, spans), {
      ids: [owner, layer],
      spans,
    });
    const alone = await d.store(({ id, spans }) => globalThis.__readAudioEnergy(id, spans), { id: owner, spans });
    await d.store(() => void globalThis.__store.getState().saveActiveFile());
    await page.getByRole("button", { name: "Overwrite" }).click({ timeout: 20000 });
    await page.getByText("File saved", { exact: false }).first().waitFor({ timeout: 120000 });
    const saved = wavEnergy(readWav(longPath), spans);
    const worst = Math.max(...saved.map((e, i) => Math.abs(e - mix[i]) / Math.max(mix[i], 1e-9)));
    const fromAlone = Math.max(...saved.map((e, i) => Math.abs(e - alone[i]) / Math.max(alone[i], 1e-9)));
    if (worst > 1e-3) fail(`the saved audio is not the sum: worst span energy off by ${worst}`);
    else console.log(`save wrote the sum of both layers (worst span energy off by ${worst.toExponential(2)})`);
    if (fromAlone < 1e-3) fail("the saved audio is the first layer alone");
    const dirty = await d.store(
      (ids) => ids.some((id) => globalThis.__store.getState().filesDirty[id]),
      [owner, layer],
    );
    if (dirty) fail("a layer still reads as unsaved after the save");

    // Remove the second layer, then take it back.
    await d.store((id) => globalThis.__store.getState().removeLayer(id), layer);
    await d.waitUntil(
      (s) => !s.open.includes(layer) && s.detached.includes(layer),
      "removing the layer did not hide it",
    );
    await d.waitFor(owner, ownerStart, "remove the second layer, the file");
    await d.send("undo");
    await d.waitUntil((s) => s.open.includes(layer), "undo did not bring the layer back");
    await d.settle();
    await d.waitFor(layer, layerPainted, "undo, the layer's paint");

    // Remove the first layer: the file takes the second layer's sound.
    await d.store((id) => globalThis.__store.getState().removeLayer(id), owner);
    await d.waitUntil((s) => !s.open.includes(layer), "removing the first layer did not hide the second");
    await d.settle();
    await d.waitFor(owner, layerPainted, "remove the first layer, the file holds the second's sound");
    await d.send("undo");
    await d.waitUntil((s) => s.open.includes(layer), "undo did not bring the second layer back");
    await d.settle();
    await d.waitFor(owner, ownerStart, "undo, the file");
    await d.waitFor(layer, layerPainted, "undo, the second layer");
  } finally {
    const keep = option("log", null);
    if (keep && existsSync(logPath)) copyFileSync(logPath, keep);
    await closeApp(app, profile);
  }
}

console.log(`shorter files, ${SHORT} s:`);
{
  const a = copyOf(SHORT, 11, "a");
  const b = copyOf(SHORT, 13, "b");
  const { app, page, profile, logPath } = await launch(env);
  const d = driver(app, page, logPath);
  try {
    await openFiles(app, page, [a, b]);
    await d.settle();
    const [fileB, fileA] = (await d.state()).open;
    const valuesA = await d.read(fileA);
    const valuesB = await d.read(fileB);

    await d.store(({ a, b }) => globalThis.__store.getState().addFilesAsLayers(a, [b]), { a: fileA, b: fileB });
    await d.waitUntil((s) => s.open.length === 3, "adding the file as a layer opened nothing");
    await d.settle();
    const added = await d.state();
    const copyB = added.open.find((id) => id !== fileA && id !== fileB);
    const stack = added.stacks.find((s) => s.owner === fileA);
    if (!stack || stack.layers.join() !== [fileA, copyB].join()) fail(`the file's layers are ${JSON.stringify(stack)}`);
    if (!added.open.includes(fileB)) fail("the added file did not stay open");
    await d.waitFor(copyB, valuesB, "the new layer holds the added file");
    await d.waitFor(fileB, valuesB, "the added file is unchanged");

    await d.send("undo");
    await d.waitUntil((s) => !s.open.includes(copyB), "undo did not take the added layer away");
    await d.send("redo");
    await d.waitUntil((s) => s.open.includes(copyB), "redo did not bring the added layer back");
    await d.settle();
    await d.waitFor(copyB, valuesB, "redo, the added layer");

    const before = (await d.state()).open.length;
    await d.store((id) => globalThis.__store.getState().copyLayersToFiles(id), fileA);
    await d.waitUntil((s) => s.open.length === before + 2, "copying the layers out did not open two files");
    await d.settle();
    const copied = (await d.state()).open.slice(-2);
    await d.waitFor(copied[0], valuesA, "the first copied file");
    await d.waitFor(copied[1], valuesB, "the second copied file");
    const afterCopy = await d.state();
    if (!afterCopy.stacks.some((s) => s.owner === fileA && s.layers.length === 2)) fail("copying out changed the file");

    await d.store((id) => globalThis.__store.getState().duplicateFile(id), fileA);
    await d.waitUntil((s) => s.stacks.length === 2, "the duplicate has no layers");
    await d.settle();
    const dup = (await d.state()).stacks.find((s) => s.owner !== fileA);
    if (!dup || dup.layers.length !== 2) fail(`the duplicate's layers are ${JSON.stringify(dup)}`);
    else {
      await d.waitFor(dup.layers[0], valuesA, "the duplicate's first layer");
      await d.waitFor(dup.layers[1], valuesB, "the duplicate's second layer");
    }
  } finally {
    await closeApp(app, profile);
  }
}
if (failed) process.exitCode = 1;
