#!/usr/bin/env node
// Load both native addons and assert the exports this platform should have.
//
// Loading gaborator_addon resolves its link to ONNX Runtime, so a shared library
// that was never copied beside the addon, or an rpath that does not reach it,
// fails here rather than in the packaged app.

import { createRequire } from "node:module";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const load = (name) => require(fileURLToPath(new URL(`../build/Release/${name}.node`, import.meta.url)));

const gaborator = load("gaborator_addon");
load("link_addon");

// ONNX Runtime ships no macOS x86_64 build after 1.23, so Intel Macs are the one
// target built without stem separation.
const expectSeparation = !(platform === "darwin" && arch === "x64");
const hasSeparation = typeof gaborator.aiSeparate === "function";

if (hasSeparation !== expectSeparation) {
  console.error(
    `[check-addon] ${platform}/${arch}: expected aiSeparate to be ${expectSeparation ? "present" : "absent"}, ` +
      `but it is ${hasSeparation ? "present" : "absent"}.`,
  );
  process.exit(1);
}

console.log(`[check-addon] ${platform}/${arch}: addons load, AI separation ${hasSeparation ? "built" : "not built"}.`);
