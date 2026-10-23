#!/usr/bin/env node
// Unpacks the built .ablx and loads what Live's Node host loads from it: the
// gaborator addon and the ffmpeg binary. An archive built for another platform
// fails here, the way it fails inside Live.
//
// Usage: node scripts/ci/smoke-extension.mjs [out-ext-dir]

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outExt = resolve(process.argv[2] ?? join(root, "out-ext"));

const archives = readdirSync(outExt).filter((name) => name.endsWith(".ablx"));
if (archives.length !== 1) throw new Error(`Expected one .ablx in ${outExt}, found: ${archives.join(", ") || "none"}`);
const archive = join(outExt, archives[0]);

const unpacked = mkdtempSync(join(tmpdir(), "noisecanvas-ablx-"));
try {
  // bsdtar reads zip archives on macOS and Windows alike.
  execFileSync("tar", ["-xf", archive, "-C", unpacked], { stdio: "inherit" });
  const host = join(unpacked, "host");

  const addon = createRequire(join(host, "main.cjs"))(join(host, "gaborator_addon.node"));
  if (typeof addon !== "object" || addon === null) throw new Error("gaborator_addon.node loaded, but exports nothing");
  console.log(`[smoke-ext] ${archives[0]}: gaborator addon loads (${Object.keys(addon).length} exports)`);

  const ffmpeg = join(host, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (!existsSync(ffmpeg)) throw new Error(`No ffmpeg in ${host}`);
  const ogg = join(unpacked, "tone.ogg");
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-acodec",
      "libvorbis",
      ogg,
    ],
    { stdio: "inherit" },
  );
  if (statSync(ogg).size === 0) throw new Error("ffmpeg wrote an empty .ogg");
  console.log(`[smoke-ext] ${archives[0]}: ffmpeg runs and writes .ogg`);
} finally {
  // Windows keeps a loaded .node file locked until the process exits.
  try {
    rmSync(unpacked, { recursive: true, force: true });
  } catch {
    console.log(`[smoke-ext] left ${unpacked} behind: a loaded file is still locked`);
  }
}
