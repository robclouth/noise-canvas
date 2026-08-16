import { host } from "./host";
import { resolveResourceDir } from "./resource-paths";

// Path scheme for audio files shipped with the app under resources/samples.
// Factory presets reference these via file params (e.g. { path: "bundled://reverb-ir.mp3" }).
// The bundled:// path is kept as the OpenFile.filePath so preset refs resolve, and is only
// turned into a real on-disk path at the point of analysis.
export const BUNDLED_PREFIX = "bundled://";

export function isBundledPath(path: string): boolean {
  return path.startsWith(BUNDLED_PREFIX);
}

// Resolves a bundled:// path to its absolute on-disk location under resources/samples.
export function resolveBundledPath(path: string): string {
  const name = path.slice(BUNDLED_PREFIX.length);
  return host.path.join(resolveResourceDir("samples"), name);
}
