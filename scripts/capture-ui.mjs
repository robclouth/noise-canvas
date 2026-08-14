#!/usr/bin/env node
/**
 * Captures element-level screenshots of the UI for docs/manual.md.
 *
 * Launches the packaged build in Electron, drives it into a known state, and
 * writes one WebP per target into docs/images/ui/. Targets address the app by
 * the `data-anchor` names declared in src/renderer/src/lib/ui-anchors.ts, so a
 * renamed region fails loudly here rather than producing a stale screenshot.
 *
 * Usage:
 *   node scripts/capture-ui.mjs                     capture every target
 *   node scripts/capture-ui.mjs --list              print target names and exit
 *   node scripts/capture-ui.mjs --only a,b,c        capture a subset
 *   node scripts/capture-ui.mjs --build             electron-vite build first
 *   node scripts/capture-ui.mjs --keep-open         leave the app running at the end
 *   node scripts/capture-ui.mjs --out=docs/images/ui
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_FILE = "test-audio/tone-440hz-5s.wav";
const DEMO_BRUSH = "Morph (Macros)";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** Every target names either a `data-anchor` region or the open popover. */
const anchor = (name, extra) => ({ name, spec: { kind: "anchor", anchor: name }, ...extra });

/**
 * Captures are at device scale, so even flat UI chrome is antialiased into
 * thousands of near-identical shades and lossless costs far more than it buys —
 * the sidebar is 311 KB lossless against 10 KB at this quality, with no visible
 * difference in the text. Chromium encodes losslessly only at quality 1.
 */
const QUALITY = 0.92;

/** The rest of the app, which the area registry does not describe as a region. */
const EXTRA_TARGETS = [
  { name: "window", spec: { kind: "css", selector: "#root" }, pad: 0 },

  // Effect cards, present because the demo brush uses them
  anchor("effect-blur"),
  anchor("effect-clone"),

  // Transient UI, which only exists while it is open
  {
    name: "modal-add-effect",
    spec: { kind: "popover" },
    setup: async ({ page }) => clickAndSettle(page, page.getByRole("button", { name: "Add effect" }).first()),
    teardown: dismiss,
  },
  {
    name: "modal-brush-picker",
    spec: { kind: "popover" },
    setup: async ({ page }) => clickAndSettle(page, page.getByRole("button", { name: "Add brush" }).first()),
    teardown: dismiss,
  },
  {
    name: "modal-palette-picker",
    spec: { kind: "popover" },
    setup: async ({ page }) => clickAndSettle(page, page.getByRole("button", { name: "Add palette" }).first()),
    teardown: dismiss,
  },
  {
    name: "menu-parameter",
    spec: { kind: "popover" },
    setup: async ({ page }) => clickAndSettle(page, page.getByText("Strength", { exact: true }).first()),
    teardown: dismiss,
  },
];

/**
 * One screenshot per area in the registry, so an area added to ui-areas.ts
 * gets captured without also having to be listed here — which is what the
 * drift check in the test suite asserts.
 */
async function buildTargets() {
  const areas = await registryAreas();
  return [...areas.map((name) => anchor(name)), ...EXTRA_TARGETS];
}

async function clickAndSettle(page, locator) {
  await locator.click();
  await page.waitForTimeout(450);
}

async function dismiss({ page }) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Element resolution
// ---------------------------------------------------------------------------

/**
 * Runs in the page. Finds the target element and stamps it with an attribute
 * so Playwright can then address it as an ordinary locator — which is what
 * gives us scroll-into-view for regions sitting below the fold.
 */
const RESOLVER = `(spec, captureId) => {
  const ATTR = "data-capture-id";
  for (const stale of document.querySelectorAll("[" + ATTR + "]")) stale.removeAttribute(ATTR);

  let target = null;

  if (spec.kind === "anchor") {
    target = document.querySelector('[data-anchor="' + spec.anchor + '"]');
  }

  if (spec.kind === "css") {
    target = document.querySelector(spec.selector);
  }

  if (spec.kind === "popover") {
    for (const sel of ["[class*='Menu-dropdown']", "[class*='Popover-dropdown']", "[class*='Modal-content']"]) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().height > 0) { target = el; break; }
    }
  }

  if (!target) return false;
  target.setAttribute(ATTR, captureId);
  return true;
}`;

/**
 * Anchor names the app declares, so the script can report drift. Region names
 * come from the UI_ANCHORS tuple; effect-card names are generated from
 * EFFECT_KEYS, matching the `effect-${EffectType}` template type.
 */
async function declaredAnchors() {
  const namesIn = (src, startMarker) => {
    const block = src.slice(src.indexOf(startMarker), src.indexOf("] as const", src.indexOf(startMarker)));
    return [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  };

  const anchorsSrc = await readFile(join(repoRoot, "src/renderer/src/lib/ui-anchors.ts"), "utf-8");
  const effectsSrc = await readFile(join(repoRoot, "src/renderer/src/effects/types.ts"), "utf-8");

  return new Set([
    ...namesIn(anchorsSrc, "export const UI_ANCHORS"),
    ...namesIn(effectsSrc, "export const EFFECT_KEYS").map((key) => `effect-${key}`),
  ]);
}

/**
 * The area names in the registry, in declaration order. Keys are read rather
 * than imported because this is a plain Node script and ui-areas.ts is
 * TypeScript; the anchor guard below catches anything this misreads.
 */
async function registryAreas() {
  const src = await readFile(join(repoRoot, "src/renderer/src/lib/ui-areas.ts"), "utf-8");
  const start = src.indexOf("export const UI_AREAS");
  const end = src.indexOf("} as const satisfies", start);
  const block = src.slice(start, end);
  return [...block.matchAll(/^ {2}"?([a-z][a-z-]*)"?:\s*\{$/gm)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// WebP encoding
// ---------------------------------------------------------------------------

/**
 * Runs in the page. Playwright only encodes PNG and JPEG, but the renderer is
 * Chromium and already has a WebP encoder, so the PNG is decoded and re-encoded
 * there rather than pulling in a native image dependency for a docs script.
 * Chromium encodes losslessly at quality 1 and lossily below it.
 */
const ENCODER = `async (pngBase64, quality) => {
  const raw = atob(pngBase64);
  const png = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) png[i] = raw.charCodeAt(i);

  const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: "image/webp", quality });
  if (blob.type !== "image/webp") throw new Error("Chromium refused to encode WebP");
  const bytes = new Uint8Array(await blob.arrayBuffer());

  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}`;

/**
 * Whether the file really came out lossless. The codec chunk can sit behind an
 * extended-format header and an ICC profile, so the chunks have to be walked
 * rather than read at a fixed offset.
 */
function webpMode(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const tag = buffer.subarray(offset, offset + 4).toString("ascii");
    if (tag === "VP8L") return "lossless";
    if (tag === "VP8 ") return "lossy";
    const size = buffer.readUInt32LE(offset + 4);
    offset += 8 + size + (size % 2);
  }
  return "unknown";
}

async function toWebp(page, png, quality) {
  const base64 = await page.evaluate(
    ([src, data, q]) => eval(`(${src})`)(data, q),
    [ENCODER, png.toString("base64"), quality],
  );
  return Buffer.from(base64, "base64");
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { only: null, list: false, build: false, keepOpen: false, out: "docs/images/ui" };
  for (const arg of argv.slice(2)) {
    if (arg === "--list") opts.list = true;
    else if (arg === "--build") opts.build = true;
    else if (arg === "--keep-open") opts.keepOpen = true;
    else if (arg.startsWith("--only="))
      opts.only = arg
        .slice(7)
        .split(",")
        .map((s) => s.trim());
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
  }
  return opts;
}

function electronBinary() {
  const byPlatform = {
    darwin: "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    win32: "node_modules/electron/dist/electron.exe",
  };
  return join(repoRoot, byPlatform[process.platform] ?? "node_modules/electron/dist/electron");
}

async function main() {
  const opts = parseArgs(process.argv);
  const TARGETS = await buildTargets();

  if (opts.list) {
    for (const t of TARGETS) console.log(t.name);
    return;
  }

  if (opts.build) {
    execFileSync("npx", ["electron-vite", "build"], { cwd: repoRoot, stdio: "inherit" });
  }

  const mainEntry = join(repoRoot, "out/main/index.js");
  if (!existsSync(mainEntry)) {
    console.error("No build at out/main/index.js — rerun with --build.");
    process.exit(1);
  }

  // Any target naming an anchor the app no longer declares is a rename that
  // would otherwise show up as a silently missing screenshot.
  const declared = await declaredAnchors();
  const orphans = TARGETS.filter((t) => t.spec.kind === "anchor" && !declared.has(t.spec.anchor));
  if (orphans.length) {
    console.error(`Unknown anchors (not in ui-anchors.ts): ${orphans.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }

  const outDir = resolve(repoRoot, opts.out);
  await mkdir(outDir, { recursive: true });

  // A throwaway userData keeps this out of the real app's persisted session.
  // Its session state is cleared every run so captures are reproducible — the
  // brush list and open files start from defaults instead of accumulating
  // across runs — while the GPU and shader caches survive, which is the
  // difference between a warm start and several minutes of recompiling.
  const userDataDir = join(repoRoot, ".cache/capture-ui-userdata");
  await mkdir(userDataDir, { recursive: true });
  for (const stateDir of ["Local Storage", "Session Storage", "WebStorage", "history"]) {
    await rm(join(userDataDir, stateDir), { recursive: true, force: true });
  }

  // Electron hosts (Claude Code among them) export this, which would make the
  // launched Electron run as plain Node instead.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log("Launching…");
  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env,
  });

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Shader warmup holds a loading overlay over the UI; cold runs are slow.
  console.log("Waiting for shader warmup…");
  await page.waitForFunction(() => !document.querySelector("[class*='LoadingOverlay-root']"), null, {
    timeout: 5 * 60 * 1000,
  });

  // The throwaway userData makes every run a first launch, so the walkthrough
  // offer pops up after warmup and its overlay would swallow all clicks.
  console.log("Declining walkthrough offer…");
  await page
    .getByRole("button", { name: "No thanks" })
    .click({ timeout: 15_000 })
    .catch(() => {});

  console.log("Opening demo file…");
  await app.evaluate(
    ({ BrowserWindow }, p) => {
      BrowserWindow.getAllWindows()[0].webContents.send("open-file", p);
    },
    join(repoRoot, DEMO_FILE),
  );
  await page.waitForSelector("[data-anchor='file-lane']", { timeout: 60_000 });
  await page.waitForTimeout(3000);

  // A brush with several effects and macros in play gives the Effects, Macros
  // and effect-card targets something worth showing.
  console.log(`Loading "${DEMO_BRUSH}"…`);
  await clickAndSettle(page, page.getByRole("button", { name: "Add brush" }).first());
  await page.getByPlaceholder(/search/i).fill(DEMO_BRUSH.split(" ")[0]);
  await page.waitForTimeout(300);
  // Scoped to the modal: the same name also appears in the sidebar brush list
  // once the brush has been added, and that copy sits under the overlay.
  const picker = page.locator("[class*='Modal-content']");
  await clickAndSettle(page, picker.getByText(DEMO_BRUSH, { exact: true }).first());
  await page.waitForTimeout(600);

  const wanted = opts.only ? TARGETS.filter((t) => opts.only.includes(t.name)) : TARGETS;
  const failures = [];

  for (const target of wanted) {
    try {
      if (target.setup) await target.setup({ page, app });

      const found = await page.evaluate(
        ([src, spec, id]) => eval(`(${src})`)(spec, id),
        [RESOLVER, target.spec, target.name],
      );
      if (!found) throw new Error("no element matched");

      // Going through a locator gets scroll-into-view for free, which matters
      // because the brush panel is taller than its scroll viewport.
      const locator = page.locator(`[data-capture-id="${target.name}"]`);
      await locator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);

      const box = await locator.boundingBox();
      if (!box || box.width < 2 || box.height < 2) throw new Error("element has no size");

      // A little breathing room reads better in docs than an exact crop.
      const pad = target.pad ?? 6;
      const view = page.viewportSize() ?? { width: 1600, height: 1200 };
      const x = Math.max(0, box.x - pad);
      const y = Math.max(0, box.y - pad);
      const clip = {
        x,
        y,
        width: Math.min(box.width + pad * 2, view.width - x),
        height: Math.min(box.height + pad * 2, view.height - y),
      };

      const png = await page.screenshot({ clip, scale: "device" });
      const webp = await toWebp(page, png, target.quality ?? QUALITY);
      await writeFile(join(outDir, `${target.name}.webp`), webp);

      const size = `${Math.round(webp.length / 1024)} KB ${webpMode(webp)}`;
      console.log(`  ✓ ${target.name}  ${Math.round(box.width)}×${Math.round(box.height)}  ${size}`);
    } catch (err) {
      failures.push(`${target.name}: ${err.message.split("\n")[0]}`);
    } finally {
      if (target.teardown) await target.teardown({ page, app }).catch(() => {});
    }
  }

  console.log(`\nWrote ${wanted.length - failures.length}/${wanted.length} to ${opts.out}`);
  for (const f of failures) console.log(`  ✗ ${f}`);

  if (!opts.keepOpen) await app.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
