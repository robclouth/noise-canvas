import type { FileRendererHandle } from "./file-renderer-types";

/**
 * Opens a stroke on `renderer` once the stroke before it has settled. False
 * when the file can take no stroke at all.
 */
export async function beginStrokeWhenFree(
  renderer: Pick<FileRendererHandle, "beginStrokePreview" | "whenStrokeFree">,
): Promise<boolean> {
  while (!renderer.beginStrokePreview()) {
    const freed = await new Promise<boolean>((resolve) => {
      if (!renderer.whenStrokeFree(() => resolve(true))) resolve(false);
    });
    if (!freed) return false;
  }
  return true;
}
