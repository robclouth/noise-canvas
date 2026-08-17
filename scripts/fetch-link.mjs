// Fetch the pinned Ableton Link sources that binding.gyp compiles against into
// vendor/link. Runs from npm's install hook on every platform, so it uses node
// and git rather than a shell.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const LINK_DIR = join(ROOT, "vendor", "link");
const LINK_COMMIT = "b6d5c597a1027f333a06459c8d6e064d603bbe7c";
const PINNED_FILE = join(LINK_DIR, ".pinned-commit");
const SHORT_COMMIT = LINK_COMMIT.slice(0, 7);

const git = (...args) => execFileSync("git", args, { cwd: LINK_DIR, stdio: "inherit" });

const pinnedCommit = () => {
  try {
    return readFileSync(PINNED_FILE, "utf8").trim();
  } catch {
    return null;
  }
};

if (existsSync(join(LINK_DIR, "include", "ableton")) && pinnedCommit() === LINK_COMMIT) {
  console.log(`[fetch-link] Ableton Link @ ${SHORT_COMMIT} already present, skipping.`);
  process.exit(0);
}

if (existsSync(LINK_DIR)) {
  console.log("[fetch-link] Existing vendor/link does not match pinned commit, removing.");
  rmSync(LINK_DIR, { recursive: true, force: true });
}

console.log(`[fetch-link] Fetching Ableton Link @ ${SHORT_COMMIT}...`);
mkdirSync(LINK_DIR, { recursive: true });
git("init", "-q");
git("remote", "add", "origin", "https://github.com/Ableton/link.git");
git("fetch", "--depth", "1", "-q", "origin", LINK_COMMIT);
git("checkout", "-q", "FETCH_HEAD");
git("submodule", "update", "--init", "--depth", "1", "-q");
writeFileSync(PINNED_FILE, `${LINK_COMMIT}\n`);
console.log("[fetch-link] Ableton Link ready.");
