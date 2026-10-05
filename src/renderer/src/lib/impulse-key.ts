import type { State } from "@renderer/store/types";

/** The path of the file a convolve step filters through, or null for the file it paints on. */
export function responsePath(state: State): string | null {
  return state.convolveIrFile?.path ?? state.sourceFile?.path ?? null;
}

/**
 * The key a convolve step's response is held under: the path of the file it
 * names, or of the file it paints from when it names none, and the empty
 * string when it paints from the file it is painting on.
 */
export function impulseKey(state: State): string {
  return responsePath(state) ?? "";
}

/** The key a step's Attract field file is held under. */
export function attractFieldKey(path: string): string {
  return `attract:${path}`;
}
