import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
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
});

await copyFile(join(root, "src/extension/manifest.json"), join(outDir, "manifest.json"));
