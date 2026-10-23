#!/usr/bin/env node
// Opens the packaged app the way a user does, then opens a short file in it.
// The window has to draw its empty screen, and the file has to reach its
// spectrogram view, which only mounts once ffmpeg and the packaged gaborator
// addon have analysed it. CI runners have no GPU, so the picture itself is not
// checked: the WebGL state is reported, and screenshots of both states land in
// dist/smoke/ for the run's artifacts when the runner can produce a frame.
//
// Usage: node scripts/ci/smoke-app.mjs [dist-dir]

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeNoise } from "../drive/app.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { _electron } = createRequire(join(root, "package.json"))("playwright");
const dist = resolve(process.argv[2] ?? join(root, "dist"));
const shots = join(dist, "smoke");
const LAUNCH_TIMEOUT_MS = 180_000;
const OPEN_TIMEOUT_MS = 300_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;

/** The unpacked app electron-builder leaves beside the installers. */
function findExecutable() {
  const candidates = {
    darwin: ["mac-arm64", "mac", "mac-universal"].map((dir) =>
      join(dist, dir, "Noise Canvas.app", "Contents", "MacOS", "Noise Canvas"),
    ),
    win32: [join(dist, "win-unpacked", "Noise Canvas.exe")],
    linux: [join(dist, "linux-unpacked", "noise-canvas"), join(dist, "linux-unpacked", "Noise Canvas")],
  }[process.platform];
  const found = candidates?.find((path) => existsSync(path));
  if (!found) {
    const listing = existsSync(dist) ? readdirSync(dist).join(", ") : "(missing)";
    throw new Error(`No unpacked app in ${dist}. It holds: ${listing}`);
  }
  return found;
}

/**
 * CI runners have no GPU. Chromium only falls back to SwiftShader for WebGL
 * when asked, and the app picks its own ANGLE backend on Windows.
 */
function gpuArgs(env) {
  if (process.platform === "linux") return ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  if (process.platform === "win32") {
    env.NOISE_CANVAS_ANGLE = "swiftshader";
    return ["--enable-unsafe-swiftshader"];
  }
  return [];
}

/** Closes the first-launch welcome prompt, which can open a few seconds after the window. */
async function dismissWelcome(page) {
  const noThanks = page.getByText("No thanks", { exact: false }).first();
  if (await noThanks.isVisible().catch(() => false)) await noThanks.click();
}

/** Saves a screenshot if the runner produces a frame in time; a GPU-less runner may not. */
async function shoot(page, state) {
  const path = join(shots, `${process.platform}-${process.arch}-${state}.png`);
  try {
    await page.screenshot({ path, timeout: SCREENSHOT_TIMEOUT_MS });
  } catch (error) {
    console.log(`[smoke] no ${state} screenshot: ${error.message.split("\n")[0]}`);
  }
}

/** Reports whether this runner can give the page a WebGL2 context. */
async function reportWebgl(page) {
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  console.log(`[smoke] WebGL2: ${renderer ?? "unavailable"} (the picture is not checked)`);
}

async function main() {
  const executablePath = findExecutable();
  const profile = mkdtempSync(join(tmpdir(), "noisecanvas-smoke-"));
  const audio = writeNoise(join(profile, "smoke-noise.wav"), 4);
  mkdirSync(shots, { recursive: true });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [`--user-data-dir=${profile}`, ...gpuArgs(env)];
  console.log(`[smoke] launching ${executablePath} ${args.join(" ")}`);

  const app = await _electron.launch({ executablePath, args, env, timeout: LAUNCH_TIMEOUT_MS });
  const errors = [];
  let page;
  try {
    page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });

    await page.getByText("No audio file open").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await page.waitForTimeout(3000);
    await dismissWelcome(page);
    console.log("[smoke] the window draws its empty screen");
    await reportWebgl(page);
    await shoot(page, "empty");

    await app.evaluate(
      ({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].webContents.send("open-file", path),
      audio,
    );
    await page.waitForSelector("[data-file-view-id]", { timeout: OPEN_TIMEOUT_MS });
    await page.waitForTimeout(3000);
    await dismissWelcome(page);
    console.log("[smoke] a file is analysed and its view opens");
    await shoot(page, "file");
  } catch (error) {
    if (page) await shoot(page, "failed");
    for (const line of errors) console.error(`[smoke] ${line}`);
    throw error;
  } finally {
    await app.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }

  if (errors.length > 0) {
    console.log(`[smoke] ${errors.length} renderer errors, for information:`);
    for (const line of errors) console.log(`[smoke]   ${line}`);
  }
}

main().catch((error) => {
  console.error(`[smoke] FAILED: ${error.message}`);
  process.exit(1);
});
