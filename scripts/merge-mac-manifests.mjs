#!/usr/bin/env node
// Merge the per-arch latest-mac.yml files electron-builder writes into one
// manifest listing every arch, so electron-updater can find a build for both
// arm64 and Intel Macs.
//
// Usage: node scripts/merge-mac-manifests.mjs <search-dir> <output-file>

import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import yaml from "js-yaml";

/** Recursively collect every `latest-mac.yml` beneath `dir`. */
function findManifests(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findManifests(path));
    else if (entry.name === "latest-mac.yml") found.push(path);
  }
  return found;
}

const [searchDir, outputFile] = process.argv.slice(2);
if (!searchDir || !outputFile) {
  console.error("usage: merge-mac-manifests.mjs <search-dir> <output-file>");
  process.exit(1);
}

const manifestPaths = findManifests(searchDir).sort();
if (manifestPaths.length === 0) {
  console.error(`no latest-mac.yml found under ${searchDir}`);
  process.exit(1);
}

const manifests = manifestPaths.map((path) => {
  console.log(`reading ${path}`);
  return yaml.load(readFileSync(path, "utf8"));
});

const versions = new Set(manifests.map((m) => m.version));
if (versions.size > 1) {
  console.error(`version mismatch across manifests: ${[...versions].join(", ")}`);
  process.exit(1);
}

const files = [];
const seen = new Set();
for (const manifest of manifests) {
  for (const file of manifest.files ?? []) {
    if (seen.has(file.url)) continue;
    seen.add(file.url);
    files.push(file);
  }
}

const merged = { ...manifests[0], files };

mkdirSync(dirname(outputFile), { recursive: true });
writeFileSync(outputFile, yaml.dump(merged, { lineWidth: -1 }), "utf8");

console.log(`wrote ${outputFile} with ${files.length} files:`);
for (const file of files) console.log(`  ${file.url}`);
console.log(`size: ${statSync(outputFile).size} bytes`);
