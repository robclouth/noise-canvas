import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";

// Filesystems with coarse mtime resolution (FAT, some network mounts) can
// report the same instant up to a second apart.
const MTIME_EPSILON_MS = 1000;

/** Copy `src` over `dst` when `dst` is missing or older, preserving the mtime. */
export function copyIfNewer(src: string, dst: string): void {
  const sourceStat = statSync(src);
  let destStat: Stats | null = null;
  try {
    destStat = statSync(dst);
  } catch {
    destStat = null;
  }
  if (destStat && sourceStat.mtimeMs <= destStat.mtimeMs + MTIME_EPSILON_MS) return;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  utimesSync(dst, sourceStat.atime, sourceStat.mtime);
}

/** Recursively merge newer files from `srcDir` into `dstDir`. A missing source is a no-op. */
export function mergeNewer(srcDir: string, dstDir: string): void {
  if (!existsSync(srcDir)) return;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) mergeNewer(src, dst);
    else if (entry.isFile()) copyIfNewer(src, dst);
  }
}

/** Copy one file when it exists; a missing source means "nothing to do". */
export function copyIfExists(src: string, dst: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  const sourceStat = statSync(src);
  utimesSync(dst, sourceStat.atime, sourceStat.mtime);
}

/** Remove a file or tree when it exists. */
export function removeIfExists(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Two-way newer-wins merge of the named subdirs between two roots. */
export function syncTrees(rootA: string, rootB: string, subdirs: string[]): void {
  for (const subdir of subdirs) {
    mergeNewer(join(rootA, subdir), join(rootB, subdir));
    mergeNewer(join(rootB, subdir), join(rootA, subdir));
  }
}
