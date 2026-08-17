// Download the ONNX Runtime shared library that backs the native AI separation
// path (GABORATOR_ONNX_ENABLED in binding.gyp) into vendor/onnxruntime. Runs
// from npm's install hook on every platform, so it uses node rather than a
// shell.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const ONNX_VERSION = "1.24.3";
const ONNX_DIR = join(ROOT, "vendor", "onnxruntime");
const DOWNLOAD_ATTEMPTS = 3;

const target = () => {
  switch (process.platform) {
    case "darwin":
      // ONNX Runtime published its last macOS x86_64 build for 1.23, so Intel
      // Macs build without the separation path rather than pinning an older
      // runtime.
      if (process.arch !== "arm64") {
        console.log(`[fetch-onnx] No macOS ONNX Runtime build for ${process.arch}, skipping.`);
        return null;
      }
      return {
        package: `onnxruntime-osx-arm64-${ONNX_VERSION}`,
        extension: "tgz",
        marker: join(ONNX_DIR, "lib", `libonnxruntime.${ONNX_VERSION}.dylib`),
      };
    case "linux":
      return {
        package: `onnxruntime-linux-x64-${ONNX_VERSION}`,
        extension: "tgz",
        marker: join(ONNX_DIR, "lib", "libonnxruntime.so.1"),
      };
    case "win32":
      return {
        package: `onnxruntime-win-x64-${ONNX_VERSION}`,
        extension: "zip",
        marker: join(ONNX_DIR, "lib", "onnxruntime.dll"),
      };
    default:
      console.log(`[fetch-onnx] No ONNX Runtime build for ${process.platform}, skipping.`);
      return null;
  }
};

const download = async (url, destination) => {
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      console.log(`[fetch-onnx] Download attempt ${attempt} failed: ${error.message}`);
    }
  }
  throw lastError;
};

const build = target();
if (!build) process.exit(0);

if (existsSync(build.marker)) {
  console.log(`[fetch-onnx] ONNX Runtime ${ONNX_VERSION} (${build.package}) already present, skipping.`);
  process.exit(0);
}

const archive = `${build.package}.${build.extension}`;
const url = `https://github.com/microsoft/onnxruntime/releases/download/v${ONNX_VERSION}/${archive}`;
const scratch = mkdtempSync(join(tmpdir(), "fetch-onnx-"));

try {
  console.log(`[fetch-onnx] Downloading ${archive}...`);
  const archivePath = join(scratch, archive);
  await download(url, archivePath);

  console.log("[fetch-onnx] Extracting into vendor/onnxruntime...");
  rmSync(ONNX_DIR, { recursive: true, force: true });
  mkdirSync(ONNX_DIR, { recursive: true });

  // bsdtar ships with Windows and reads zip as well as tar, so one extraction
  // covers every platform. The Windows archive carries a 380 MB .pdb the build
  // does not need.
  execFileSync("tar", ["-xf", archivePath, "-C", ONNX_DIR, "--strip-components", "1", "--exclude", "*.pdb"], {
    stdio: "inherit",
  });

  // The Linux archive names the real library by full version and reaches it
  // through two symlinks. gyp copies files rather than links, and the addon's
  // DT_NEEDED records the SONAME, so the SONAME must be the real file.
  if (process.platform === "linux") {
    const versioned = join(ONNX_DIR, "lib", `libonnxruntime.so.${ONNX_VERSION}`);
    const soname = join(ONNX_DIR, "lib", "libonnxruntime.so.1");
    const unversioned = join(ONNX_DIR, "lib", "libonnxruntime.so");
    rmSync(soname, { force: true });
    renameSync(versioned, soname);
    rmSync(unversioned, { force: true });
    symlinkSync("libonnxruntime.so.1", unversioned);
  }

  if (!existsSync(build.marker)) {
    console.error(`[fetch-onnx] Expected ${build.marker} after extraction but not found.`);
    process.exit(1);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`[fetch-onnx] ONNX Runtime ${ONNX_VERSION} (${build.package}) ready.`);
