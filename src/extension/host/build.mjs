import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Bundles the Node extension host (the SDK-facing glue + localhost data plane)
// into a single CommonJS file Ableton's embedded Node runtime loads. The webview
// is built separately by vite.extension.config.ts; both land under out-ext/.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

await build({
  entryPoints: [resolve(root, "src/extension/host/main.ts")],
  outfile: resolve(root, "out-ext/host/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // The SDK is supplied by the host runtime, not bundled (and is an off-registry
  // beta that may be absent at build time). Leaving it external resolves it at
  // load time inside Live.
  external: ["@ableton-extensions/sdk"],
  logLevel: "info",
});
