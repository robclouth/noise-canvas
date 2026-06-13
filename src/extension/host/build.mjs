import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

const manifestPath = join(root, "src/extension/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await copyFile(manifestPath, join(outDir, "manifest.json"));

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
