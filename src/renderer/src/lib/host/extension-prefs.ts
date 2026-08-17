import type { HostPrefs } from "./types";
import { extensionFs, getUserDataPath } from "./extension-rpc";

// The persisted store slice, held in the extension's storage directory rather
// than in localStorage: Live serves the editor from an ephemeral localhost port,
// so every run is a new origin with empty web storage.
//
// One file per key under <userData>/prefs. The whole folder is read into memory
// by loadPrefs() before the app mounts, which keeps HostPrefs.read synchronous;
// writes go through to disk and are already debounced by the caller.
const PREFS_SUBFOLDER_NAME = "prefs";

const cache = new Map<string, string>();
let prefsDir: string | null = null;

function fileFor(name: string): string | null {
  return prefsDir ? `${prefsDir}/${encodeURIComponent(name)}.json` : null;
}

export async function loadPrefs(): Promise<void> {
  prefsDir = `${await getUserDataPath()}/${PREFS_SUBFOLDER_NAME}`;
  await extensionFs.mkdir(prefsDir, { recursive: true });

  const files = await extensionFs.readdir(prefsDir);
  await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const name = decodeURIComponent(file.slice(0, -".json".length));
        cache.set(name, await extensionFs.readFile(`${prefsDir}/${file}`, "utf-8"));
      }),
  );
}

export const extensionPrefs: HostPrefs = {
  read: (name) => cache.get(name) ?? null,

  write: (name, value) => {
    cache.set(name, value);
    const file = fileFor(name);
    if (!file) return;
    void extensionFs.writeFile(file, value).catch((error: unknown) => {
      console.error(`Failed to save ${name}:`, error);
    });
  },

  remove: (name) => {
    cache.delete(name);
    const file = fileFor(name);
    if (!file) return;
    void extensionFs.unlink(file).catch(() => {});
  },
};
