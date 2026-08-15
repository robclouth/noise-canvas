#!/usr/bin/env node
// Assert every packaged app carries the native addon and, where the platform
// builds it, the ONNX Runtime library the addon links. Both must sit in the same
// unpacked directory, because that is where the addon resolves the library from.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:process";

// ONNX Runtime ships no macOS x86_64 build after 1.23, so Intel Macs are the one
// target packaged without stem separation.
const ONNX_LIBRARY = {
  darwin: arch === "x64" ? null : "libonnxruntime.1.24.3.dylib",
  win32: "onnxruntime.dll",
  linux: "libonnxruntime.so.1",
}[platform];

/** Every `app.asar.unpacked/build/Release` directory beneath `dir`. */
function findUnpackedAddonDirs(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === "app.asar.unpacked") {
      const release = join(path, "build", "Release");
      if (existsSync(release)) found.push(release);
      continue;
    }
    findUnpackedAddonDirs(path, found);
  }
  return found;
}

const addonDirs = findUnpackedAddonDirs("dist");
if (addonDirs.length === 0) {
  console.error("[check-package] no app.asar.unpacked/build/Release found under dist/.");
  process.exit(1);
}

const required = ["gaborator_addon.node", "link_addon.node", ...(ONNX_LIBRARY ? [ONNX_LIBRARY] : [])];
let failed = false;

for (const dir of addonDirs) {
  const missing = required.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) {
    console.error(`[check-package] ${dir} is missing: ${missing.join(", ")}`);
    console.error(`  contains: ${readdirSync(dir).join(", ")}`);
    failed = true;
  } else {
    console.log(`[check-package] ${dir}: ${required.join(", ")}`);
  }
}

if (failed) process.exit(1);
console.log(`[check-package] ${platform}/${arch}: ${addonDirs.length} packaged app(s) complete.`);
