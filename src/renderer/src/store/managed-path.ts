// Sentinel scheme for managed (unsaved-to-disk) files. Lets the existing
// path-keyed maps (filepathsBpm, brush sourceFile refs, getFileColor) treat
// managed files identically to real files until the user picks a real path.
// Kept dependency-free so modules like the history manager can detect managed
// files without pulling in the parameter/effect graph.
const MANAGED_PATH_PREFIX = "managed://";

export function makeManagedFilePath(fileId: string): string {
  return `${MANAGED_PATH_PREFIX}${fileId}`;
}

export function isManagedFilePath(filePath: string): boolean {
  return filePath.startsWith(MANAGED_PATH_PREFIX);
}
