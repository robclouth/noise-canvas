import { host } from "./host";

// Path scheme for audio files shipped with the app under resources/samples.
// Factory presets reference these via file params (e.g. { path: "bundled://reverb-ir.mp3" }).
// The bundled:// path is kept as the OpenFile.filePath so preset refs resolve, and is only
// turned into a real on-disk path at the point of analysis.
export const BUNDLED_PREFIX = "bundled://";

export function isBundledPath(path: string): boolean {
  return path.startsWith(BUNDLED_PREFIX);
}

function getSamplesDir(): string {
  const isDev = host.env.nodeEnv === "development" || window.location.protocol === "http:";
  return isDev
    ? host.path.join(host.env.cwd(), "resources", "samples")
    : host.path.join(host.env.resourcesPath, "samples");
}

// Resolves a bundled:// path to its absolute on-disk location under resources/samples.
export function resolveBundledPath(path: string): string {
  const name = path.slice(BUNDLED_PREFIX.length);
  return host.path.join(getSamplesDir(), name);
}
