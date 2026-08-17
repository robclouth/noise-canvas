import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// The preset subfolders both builds share. Everything else under the storage
// directory (history, prefs) stays extension-local.
const SHARED_SUBDIRS = ["Presets", "Palettes", "Textures"];

const HELPER_PATH = join(__dirname, "sync-helper.cjs");

/** The desktop app's preset root (see the renderer's folders.ts). */
export function documentsRoot(): string {
  return join(homedir(), "Documents", "Noise Canvas");
}

// Helper runs are serialised so rapid writes to one file land in order.
let queue: Promise<unknown> = Promise.resolve();

function runHelper(args: string[]): Promise<void> {
  const run = (): Promise<void> =>
    new Promise((resolvePromise, rejectPromise) => {
      // A fresh child carries none of the parent's --permission flags, so it
      // can reach the Documents tree. NODE_OPTIONS is cleared so no inherited
      // flag re-sandboxes it.
      const child = spawn(process.execPath, [HELPER_PATH, ...args], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, NODE_OPTIONS: "" },
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", rejectPromise);
      child.on("exit", (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`sync-helper ${args[0]} failed (${code}): ${stderr.trim()}`));
      });
    });
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** Two-way newer-wins merge of the shared preset tree with the Documents tree. */
export function syncSharedTree(storageRoot: string): Promise<void> {
  return runHelper(["sync", storageRoot, documentsRoot(), ...SHARED_SUBDIRS]);
}

/** The Documents-tree twin of a storage-tree path, or null for extension-local paths. */
export function sharedTwinPath(storageRoot: string, filePath: string, root = documentsRoot()): string | null {
  const rel = relative(resolve(storageRoot), resolve(filePath));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const [top] = rel.split(sep);
  if (!SHARED_SUBDIRS.includes(top)) return null;
  return join(root, rel);
}

/** Mirror a write inside the shared tree to its Documents twin. */
export function mirrorWrite(storageRoot: string, filePath: string): void {
  const twin = sharedTwinPath(storageRoot, filePath);
  if (!twin) return;
  runHelper(["copy", filePath, twin]).catch((error: unknown) => {
    console.error(`Noise Canvas: mirroring ${filePath} to Documents failed`, error);
  });
}

/** Mirror a delete inside the shared tree to its Documents twin. */
export function mirrorRemove(storageRoot: string, filePath: string): void {
  const twin = sharedTwinPath(storageRoot, filePath);
  if (!twin) return;
  runHelper(["remove", twin]).catch((error: unknown) => {
    console.error(`Noise Canvas: removing the Documents twin of ${filePath} failed`, error);
  });
}

/** Copy a file the sandbox cannot reach (e.g. a clip's .asd sidecar); a missing source is a no-op. */
export function copyOutsideSandbox(src: string, dst: string): Promise<void> {
  return runHelper(["copy", src, dst]);
}
