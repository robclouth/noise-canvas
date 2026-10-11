// Download the ONNX Runtime shared library that backs the native AI paths
// (GABORATOR_ONNX_ENABLED in binding.gyp) into vendor/onnxruntime, and, where
// the runtime does not carry it, the WebGPU execution provider that plugs into
// it at run time beside it. Runs from npm's install hook on every platform, so
// it uses node rather than a shell.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const ONNX_VERSION = "1.30.0";
const WEBGPU_EP_VERSION = "0.4.0";
const ONNX_DIR = join(ROOT, "vendor", "onnxruntime");
const LIB_DIR = join(ONNX_DIR, "lib");
const DOWNLOAD_ATTEMPTS = 3;

const target = () => {
  switch (process.platform) {
    case "darwin":
      // ONNX Runtime published its last macOS x86_64 build for 1.23, so Intel
      // Macs build without the ONNX paths rather than pinning an older
      // runtime.
      if (process.arch !== "arm64") {
        console.log(`[fetch-onnx] No macOS ONNX Runtime build for ${process.arch}, skipping.`);
        return null;
      }
      return {
        package: `onnxruntime-osx-arm64-${ONNX_VERSION}`,
        extension: "tgz",
        marker: join(LIB_DIR, `libonnxruntime.${ONNX_VERSION}.dylib`),
        // The macOS runtime carries the WebGPU provider itself.
        webgpu: null,
      };
    case "linux":
      return {
        package: `onnxruntime-linux-x64-${ONNX_VERSION}`,
        extension: "tgz",
        marker: join(LIB_DIR, "libonnxruntime.so.1"),
        webgpu: { rid: "linux-x64", files: ["libonnxruntime_providers_webgpu.so"] },
      };
    case "win32":
      return {
        package: `onnxruntime-win-x64-${ONNX_VERSION}`,
        extension: "zip",
        marker: join(LIB_DIR, "onnxruntime.dll"),
        webgpu: { rid: "win-x64", files: ["onnxruntime_providers_webgpu.dll", "dxil.dll", "dxcompiler.dll"] },
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

const fetchRuntime = async (build, scratch) => {
  const archive = `${build.package}.${build.extension}`;
  const url = `https://github.com/microsoft/onnxruntime/releases/download/v${ONNX_VERSION}/${archive}`;
  console.log(`[fetch-onnx] Downloading ${archive}...`);
  const archivePath = join(scratch, archive);
  await download(url, archivePath);

  console.log("[fetch-onnx] Extracting into vendor/onnxruntime...");
  const extracted = join(scratch, "extracted");
  mkdirSync(extracted, { recursive: true });

  // bsdtar ships with Windows and reads zip as well as tar, so one extraction
  // covers every platform. The Windows archive carries a 380 MB .pdb and the
  // macOS one a debug-symbol bundle, neither of which the build needs. Some
  // archives prefix every entry with "./", so the package's single top folder
  // is found after extraction rather than stripped by count.
  execFileSync("tar", ["-xf", archivePath, "-C", extracted, "--exclude", "*.pdb", "--exclude", "*.dSYM"], {
    stdio: "inherit",
  });
  const top = readdirSync(extracted).filter((name) => existsSync(join(extracted, name, "lib")));
  if (top.length !== 1) throw new Error(`Expected one package folder in ${archive}, found ${top.length}`);
  rmSync(ONNX_DIR, { recursive: true, force: true });
  mkdirSync(join(ONNX_DIR, ".."), { recursive: true });
  renameSync(join(extracted, top[0]), ONNX_DIR);

  // The Linux archive names the real library by full version and reaches it
  // through two symlinks. gyp copies files rather than links, and the addon's
  // DT_NEEDED records the SONAME, so the SONAME must be the real file.
  if (process.platform === "linux") {
    const versioned = join(LIB_DIR, `libonnxruntime.so.${ONNX_VERSION}`);
    const soname = join(LIB_DIR, "libonnxruntime.so.1");
    const unversioned = join(LIB_DIR, "libonnxruntime.so");
    rmSync(soname, { force: true });
    renameSync(versioned, soname);
    rmSync(unversioned, { force: true });
    symlinkSync("libonnxruntime.so.1", unversioned);
  }
};

// The WebGPU provider ships only inside Microsoft's NuGet and pip packages; the
// NuGet package is a zip with one native folder per platform. GNU tar, which
// Linux has, cannot read a zip, so Linux unzips it.
const fetchWebGpu = async (build, scratch) => {
  const archivePath = join(scratch, "webgpu.nupkg");
  const url = `https://www.nuget.org/api/v2/package/Microsoft.ML.OnnxRuntime.EP.WebGpu/${WEBGPU_EP_VERSION}`;
  console.log(`[fetch-onnx] Downloading the WebGPU provider ${WEBGPU_EP_VERSION}...`);
  await download(url, archivePath);
  const members = build.webgpu.files.map((f) => `runtimes/${build.webgpu.rid}/native/${f}`);
  if (process.platform === "linux") {
    execFileSync("unzip", ["-o", "-j", archivePath, ...members, "-d", LIB_DIR], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xf", archivePath, "-C", LIB_DIR, "--strip-components", "3", ...members], {
      stdio: "inherit",
    });
  }
};

const build = target();
if (!build) process.exit(0);

const webgpuMarkers = build.webgpu ? build.webgpu.files.map((file) => join(LIB_DIR, file)) : [];
const needsRuntime = !existsSync(build.marker);
const needsWebGpu = needsRuntime || webgpuMarkers.some((marker) => !existsSync(marker));
if (!needsWebGpu) {
  console.log(`[fetch-onnx] ONNX Runtime ${ONNX_VERSION} and its WebGPU provider already present, skipping.`);
  process.exit(0);
}

// The scratch folder sits beside the runtime's, on the same drive, so the
// extracted package can be renamed into place.
mkdirSync(join(ONNX_DIR, ".."), { recursive: true });
const scratch = mkdtempSync(join(ONNX_DIR, "..", ".fetch-onnx-"));
try {
  if (needsRuntime) await fetchRuntime(build, scratch);
  if (build.webgpu) await fetchWebGpu(build, scratch);
  for (const marker of [build.marker, ...webgpuMarkers]) {
    if (!existsSync(marker)) {
      console.error(`[fetch-onnx] Expected ${marker} after extraction but not found.`);
      process.exit(1);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  `[fetch-onnx] ONNX Runtime ${ONNX_VERSION} (${build.package}) and WebGPU provider ${WEBGPU_EP_VERSION} ready.`,
);
