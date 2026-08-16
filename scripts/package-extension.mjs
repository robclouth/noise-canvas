import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Archives out-ext/ into a .ablx. extensions-cli bundles manifest.json and the
// manifest's entry file and nothing else, so every other artefact build.mjs put
// beside the entry — the gaborator addon, the platform's ONNX Runtime library,
// the sample and HRTF trees — has to be named as an include or it is silently
// left out. The list is read off the built directory rather than written down:
// the ONNX library's name differs per platform, Intel macOS ships none at all,
// and a named include that does not exist makes the CLI exit non-zero.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out-ext");

const hostIncludes = readdirSync(join(outDir, "host"))
  // The entry is archived by the CLI itself; including it again would put two
  // copies of the bundle in the zip under the same name.
  .filter((name) => name !== "main.cjs")
  .map((name) => `host/${name}`);

const includes = ["webview", ...hostIncludes];
console.log(`packaging with includes: ${includes.join(", ")}`);

// One -i per path: the flag takes a single value, and a second bare path is
// read as the extension directory instead.
const args = ["extensions-cli", "package", ...includes.flatMap((inc) => ["-i", inc]), "-o", "noise-canvas.ablx"];
execFileSync("npx", args, { cwd: outDir, stdio: "inherit" });
