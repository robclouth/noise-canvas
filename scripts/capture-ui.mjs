#!/usr/bin/env node
/**
 * Captures element-level screenshots of the UI for docs/manual.md.
 *
 * Launches the packaged renderer in Electron, drives it into a known state,
 * resolves each documented UI element to its natural container element, and
 * writes one PNG per target into docs/images/ui/.
 *
 * Usage:
 *   node scripts/capture-ui.mjs                     capture every target
 *   node scripts/capture-ui.mjs --list              print target names and exit
 *   node scripts/capture-ui.mjs --only a,b,c        capture a subset
 *   node scripts/capture-ui.mjs --build             electron-vite build first
 *   node scripts/capture-ui.mjs --keep-open         leave the app running at the end
 *   node scripts/capture-ui.mjs --out docs/images/ui
 */

import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Element resolution
// ---------------------------------------------------------------------------

/**
 * Runs in the page. Resolves a target spec to a single element and stamps it
 * with a data attribute so Playwright can address it as a locator.
 *
 * Spec kinds:
 *   css        - plain CSS selector, optionally the nth match
 *   section    - a <Section> in the brush panel or sidebar, found by its label
 *                and widened to the smallest ancestor that also holds the
 *                section body, so the shot frames header + contents together
 *   effect     - one effect card in the Effects list, found by its title
 *   labelRow   - the control row owning a parameter label
 *   popover    - the currently open Mantine dropdown / modal / popover
 */
const RESOLVER = `(spec, captureId) => {
  const ATTR = "data-capture-id";
  for (const stale of document.querySelectorAll("[" + ATTR + "]")) stale.removeAttribute(ATTR);

  const leafTextNodes = (text) =>
    Array.from(document.querySelectorAll("p, span, div, button, h1, h2, h3, h4")).filter(
      (el) => el.childElementCount === 0 && el.textContent.trim() === text,
    );

  // Climbs from a starting element to the nearest ancestor satisfying test().
  const climbTo = (start, test, maxDepth = 8) => {
    let el = start;
    for (let i = 0; i < maxDepth && el; i++) {
      el = el.parentElement;
      if (el && test(el)) return el;
    }
    return null;
  };

  const isCollapseBody = (el) =>
    Array.from(el.children).some(
      (child) => child.className && String(child.className).includes("Collapse"),
    );

  let target = null;

  if (spec.kind === "css") {
    const all = document.querySelectorAll(spec.selector);
    target = all[spec.nth ?? 0] ?? null;
  }

  if (spec.kind === "section") {
    for (const label of leafTextNodes(spec.label)) {
      // The Section root is the smallest ancestor holding both the header row
      // and the collapsible body.
      const root = climbTo(label, isCollapseBody);
      if (root) { target = root; break; }
    }
  }

  if (spec.kind === "effect") {
    for (const title of leafTextNodes(spec.label)) {
      const card = climbTo(title, (el) => el.className && String(el.className).includes("Paper"));
      if (card) { target = card; break; }
    }
  }

  if (spec.kind === "labelRow") {
    for (const label of leafTextNodes(spec.label)) {
      const row = climbTo(label, (el) => el.getBoundingClientRect().width > 120, 3);
      if (row) { target = row; break; }
    }
  }

  if (spec.kind === "popover") {
    const candidates = [
      ".mantine-Menu-dropdown",
      ".mantine-Popover-dropdown",
      ".mantine-Modal-content",
      "[class*='Menu-dropdown']",
      "[class*='Popover-dropdown']",
      "[class*='Modal-content']",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().height > 0) { target = el; break; }
    }
  }

  if (!target) return null;
  target.setAttribute(ATTR, captureId);
  const r = target.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}`;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * `setup` runs before the shot and receives the driver helpers. Setups are
 * cumulative in list order, so targets sharing a state are grouped together.
 */
const TARGETS = [
  { name: "window", spec: { kind: "css", selector: "#root" }, pad: 0 },

  // Panels
  { name: "brush-panel", spec: { kind: "css", selector: "[data-capture-region='brush-panel']" } },
  { name: "sidebar", spec: { kind: "css", selector: "[data-capture-region='sidebar']" } },
  { name: "transport-bar", spec: { kind: "css", selector: "[data-capture-region='transport']" } },
  { name: "file-view", spec: { kind: "css", selector: "[data-capture-region='file-lane']" } },
  { name: "file-header", spec: { kind: "css", selector: "[data-capture-region='file-header']" } },

  // Brush panel sections
  { name: "section-macros", spec: { kind: "section", label: "Macros" } },
  { name: "section-steps", spec: { kind: "section", label: "Steps" } },
  { name: "section-source", spec: { kind: "section", label: "Source" } },
  { name: "section-envelope", spec: { kind: "section", label: "Envelope" } },
  { name: "section-options", spec: { kind: "section", label: "Options" } },
  { name: "section-effects", spec: { kind: "section", label: "Effects" } },
  { name: "section-modulators", spec: { kind: "section", label: "Modulators" } },

  // Sidebar sections
  { name: "section-brushes", spec: { kind: "section", label: "Brushes" } },
  { name: "section-history", spec: { kind: "section", label: "History" } },

  // Individual effect cards, from the loaded demo brush
  { name: "effect-blur", spec: { kind: "effect", label: "Blur" } },
  { name: "effect-clone", spec: { kind: "effect", label: "Clone" } },

  // Transient UI that needs driving
  {
    name: "modal-add-effect",
    spec: { kind: "popover" },
    setup: async ({ page }) => {
      await page.getByRole("button", { name: "Add effect" }).first().click();
      await page.waitForTimeout(400);
    },
    teardown: async ({ page }) => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    },
  },
  {
    name: "modal-brush-picker",
    spec: { kind: "popover" },
    setup: async ({ page }) => {
      await page.getByRole("button", { name: "New brush" }).first().click();
      await page.waitForTimeout(400);
    },
    teardown: async ({ page }) => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    },
  },
  {
    name: "menu-parameter",
    spec: { kind: "popover" },
    setup: async ({ page }) => {
      await page.getByText("Strength", { exact: true }).first().click();
      await page.waitForTimeout(400);
    },
    teardown: async ({ page }) => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    },
  },
];

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
    else if (arg === "--only") opts.only = argv[argv.indexOf(arg) + 1].split(",").map((s) => s.trim());
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
  }
  return opts;
}

/**
 * Tags the panel containers the manifest addresses by name. The app doesn't
 * carry test hooks, so the regions are identified structurally here: the three
 * top-level columns of the layout Group, the transport row inside the middle
 * column, and the first file lane.
 */
const TAG_REGIONS = `() => {
  const root = document.getElementById("root");
  const columns = root ? root.querySelector("[class*='Stack-root'] > [class*='Group-root']") : null;
  const mark = (el, name) => { if (el) el.setAttribute("data-capture-region", name); };

  if (columns) {
    const kids = Array.from(columns.children).filter((el) => el.getBoundingClientRect().width > 40);
    // Left ScrollArea = brush panel, middle Stack = canvas, right = sidebar.
    mark(kids[0], "brush-panel");
    mark(kids[kids.length - 1], "sidebar");
    const middle = kids.find((el) => el.querySelector("[data-file-view-id]"));
    if (middle) {
      const rows = Array.from(middle.children);
      mark(rows[rows.length - 1], "transport");
    }
  }

  const view = document.querySelector("[data-file-view-id]");
  if (view) {
    const lane = view.closest("[class*='Box-root']") || view.parentElement;
    mark(lane, "file-lane");
    const header = lane ? lane.querySelector("[class*='Group-root']") : null;
    mark(header, "file-header");
  }
  return document.querySelectorAll("[data-capture-region]").length;
}`;

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.list) {
    for (const t of TARGETS) console.log(t.name);
    return;
  }

  if (opts.build) {
    console.log("Building…");
    execFileSync("npx", ["electron-vite", "build"], { cwd: repoRoot, stdio: "inherit" });
  }

  const mainEntry = join(repoRoot, "out/main/index.js");
  if (!existsSync(mainEntry)) {
    console.error("No build found at out/main/index.js — run with --build first.");
    process.exit(1);
  }

  const outDir = resolve(repoRoot, opts.out);
  await mkdir(outDir, { recursive: true });

  // A throwaway userData keeps the capture session out of the real app's
  // persisted state (open files, brushes, history) and guarantees defaults.
  const userDataDir = join(repoRoot, ".cache/capture-ui-userdata");
  await mkdir(userDataDir, { recursive: true });

  // Claude Code and other Electron hosts export this, which makes a launched
  // Electron run as plain Node instead.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const executablePath = join(
    repoRoot,
    process.platform === "darwin"
      ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
      : process.platform === "win32"
        ? "node_modules/electron/dist/electron.exe"
        : "node_modules/electron/dist/electron",
  );

  console.log("Launching app…");
  const app = await electron.launch({
    executablePath,
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env,
  });

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Shader warmup blocks the UI behind a loading overlay; cold runs are slow.
  console.log("Waiting for shader warmup…");
  await page.waitForFunction(() => !document.querySelector("[class*='LoadingOverlay-root']"), null, {
    timeout: 5 * 60 * 1000,
  });

  console.log("Opening demo file…");
  const demoFile = join(repoRoot, "test-audio/tone-440hz-5s.wav");
  await app.evaluate(({ BrowserWindow }, p) => {
    BrowserWindow.getAllWindows()[0].webContents.send("open-file", p);
  }, demoFile);
  await page.waitForSelector("[data-file-view-id]", { timeout: 60_000 });
  await page.waitForTimeout(3000);

  // A brush with several effects and macros in play makes the Effects and
  // Macros sections show something worth documenting.
  console.log("Loading demo brush…");
  await page.getByRole("button", { name: "New brush" }).first().click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder(/search/i).fill("Morph");
  await page.waitForTimeout(300);
  await page.getByText("Morph (Macros)", { exact: true }).first().click();
  await page.waitForTimeout(1000);

  const tagged = await page.evaluate(TAG_REGIONS);
  console.log(`Tagged ${tagged} layout regions.`);

  const wanted = opts.only ? TARGETS.filter((t) => opts.only.includes(t.name)) : TARGETS;
  const failures = [];

  for (const target of wanted) {
    try {
      if (target.setup) await target.setup({ page, app });

      const box = await page.evaluate(
        ([resolverSrc, spec, id]) => eval(`(${resolverSrc})`)(spec, id),
        [RESOLVER, target.spec, target.name],
      );

      if (!box || box.width < 2 || box.height < 2) {
        failures.push(`${target.name}: no element matched`);
        if (target.teardown) await target.teardown({ page, app });
        continue;
      }

      // A little breathing room reads better in docs than an exact crop.
      const pad = target.pad ?? 6;
      const viewport = page.viewportSize() ?? { width: 1600, height: 1200 };
      const clip = {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: Math.min(box.width + pad * 2, viewport.width - Math.max(0, box.x - pad)),
        height: Math.min(box.height + pad * 2, viewport.height - Math.max(0, box.y - pad)),
      };

      const file = join(outDir, `${target.name}.png`);
      await page.screenshot({ path: file, clip, scale: "device" });
      console.log(`  ✓ ${target.name}  ${Math.round(box.width)}×${Math.round(box.height)}`);

      if (target.teardown) await target.teardown({ page, app });
    } catch (err) {
      failures.push(`${target.name}: ${err.message.split("\n")[0]}`);
      if (target.teardown) {
        try {
          await target.teardown({ page, app });
        } catch {
          /* teardown is best-effort */
        }
      }
    }
  }

  console.log(`\nWrote ${wanted.length - failures.length}/${wanted.length} to ${opts.out}`);
  if (failures.length) {
    console.log("Failed:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }

  if (!opts.keepOpen) await app.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
