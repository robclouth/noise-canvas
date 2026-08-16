import { build } from "esbuild";
import { existsSync } from "node:fs";
import { chmod, cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve, sep } from "node:path";

// Assembles the loadable extension under out-ext/: the manifest, the bundled
// Node host (this step), and the webview (built separately by
// vite.extension.config.ts). Live installs the out-ext/ directory; manifest.entry
// ("host/main.cjs") is resolved relative to it.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const outDir = join(root, "out-ext");

await mkdir(join(outDir, "host"), { recursive: true });

await build({
  entryPoints: [join(root, "src/extension/host/main.ts")],
  outfile: join(outDir, "host/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcesContent: false,
  logLevel: "info",
  // Native/binary deps must resolve at runtime from node_modules: ffmpeg-static
  // computes its binary path from its own __dirname (broken if inlined), and
  // onnxruntime-node loads a .node addon. The gaborator addon is a dynamic
  // require, so esbuild leaves it external automatically.
  external: ["ffmpeg-static", "onnxruntime-node"],
});

// The gaborator addon is a dynamic require, so esbuild leaves it out of the
// bundle. Copy it next to the host entry — getGaboratorPath() looks there
// first, and without it every stroke in a packaged extension fails.
await copyFile(join(root, "build/Release/gaborator_addon.node"), join(outDir, "host/gaborator_addon.node"));

// The addon links ONNX Runtime and resolves it from its own directory, so the
// shared library has to travel with the copy. Only one name exists per platform,
// and Intel macOS has none.
for (const library of ["libonnxruntime.1.24.3.dylib", "libonnxruntime.so.1", "onnxruntime.dll"]) {
  const from = join(root, "build/Release", library);
  if (existsSync(from)) await copyFile(from, join(outDir, "host", library));
}

// The host bundle's directory is the extension's resources root (see the
// resourcesPath the host reports at bootstrap), so the trees the renderer reads
// from resources/ — bundled:// samples and the binaural HRTF data — are copied
// beside the addon. The HRTF cache holds the source SOFA the data is generated
// from and is not read at runtime.
const hrtfCache = join(root, "resources/hrtf/cache");
for (const tree of ["samples", "hrtf"]) {
  await cp(join(root, "resources", tree), join(outDir, "host", tree), {
    recursive: true,
    filter: (source) => source !== hrtfCache && !source.startsWith(hrtfCache + sep),
  });
}

// ffmpeg-static is external to the bundle and resolves through node_modules,
// which a packaged .ablx has none of, so the binary travels beside the entry
// where resolveFfmpegPath() looks for it first.
const { default: ffmpegSource } = await import("ffmpeg-static");
if (ffmpegSource) {
  const ffmpegDest = join(outDir, "host", basename(ffmpegSource));
  await copyFile(ffmpegSource, ffmpegDest);
  await chmod(ffmpegDest, 0o755);
}

const manifestPath = join(root, "src/extension/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
// The app's version is the shipped one; the manifest carries no version of its
// own, or the extension reports a stale number inside Live on every release.
const appVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
manifest.version = appVersion;
await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// extensions-cli `run` requires a package.json in the extension directory; the
// host itself loads via manifest.entry. main mirrors that entry so the dir reads
// as a normal Node package.
const pkg = {
  name: "noise-canvas-extension",
  version: manifest.version,
  private: true,
  main: manifest.entry,
};
await writeFile(join(outDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
