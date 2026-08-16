import { host } from "./host";

// The Electron app serves the renderer over http only while developing, but the
// extension's webview is served over http in both of its builds, so the protocol
// separates dev from packaged for the app alone.
function isDevLayout(): boolean {
  if (host.env.nodeEnv === "development") return true;
  return !host.env.isExtension && window.location.protocol === "http:";
}

/** Absolute path to a directory shipped under resources/, e.g. "samples" or "hrtf". */
export function resolveResourceDir(name: string): string {
  return isDevLayout()
    ? host.path.join(host.env.cwd(), "resources", name)
    : host.path.join(host.env.resourcesPath, name);
}
