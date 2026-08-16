import { beforeEach, describe, expect, it, vi } from "vitest";

// The host facts the resolver reads; each test sets the shell and build it stands
// for. Getters, so a test can change them after the module under test imported
// the host.
const env = vi.hoisted(() => ({
  isExtension: false,
  nodeEnv: undefined as string | undefined,
  cwd: "/repo",
  resourcesPath: "/packaged/resources",
}));

// Paths the HRTF loader asked the host to read.
const readPaths = vi.hoisted(() => [] as string[]);

vi.mock("@renderer/lib/host", () => ({
  host: {
    env: {
      get isExtension() {
        return env.isExtension;
      },
      get nodeEnv() {
        return env.nodeEnv;
      },
      get resourcesPath() {
        return env.resourcesPath;
      },
      cwd: () => env.cwd,
    },
    path: {
      join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
    },
    fs: {
      readFile: (path: string) => {
        readPaths.push(path);
        return Promise.reject(new Error(`ENOENT ${path}`));
      },
    },
  },
}));

import { resolveBundledPath } from "../bundled-samples";
import { loadHrtfData } from "../hrtf-loader";
import { resolveResourceDir } from "../resource-paths";

describe("bundled resource paths", () => {
  beforeEach(() => {
    env.isExtension = false;
    env.nodeEnv = undefined;
    env.cwd = "/repo";
    env.resourcesPath = "/packaged/resources";
    readPaths.length = 0;
    // The whole point of the extension cases below: the webview is served over
    // http in the packaged extension too, so the protocol cannot mark it as dev.
    expect(window.location.protocol).toBe("http:");
  });

  it("reads a packaged extension's samples from the resources path", () => {
    env.isExtension = true;
    env.nodeEnv = "production";
    expect(resolveBundledPath("bundled://break-loop.mp3")).toBe("/packaged/resources/samples/break-loop.mp3");
  });

  it("reads the extension dev build's samples from the working tree", () => {
    env.isExtension = true;
    env.nodeEnv = "development";
    expect(resolveBundledPath("bundled://break-loop.mp3")).toBe("/repo/resources/samples/break-loop.mp3");
  });

  it("reads the app's samples from the working tree while it is served over http", () => {
    expect(resolveResourceDir("samples")).toBe("/repo/resources/samples");
  });

  it("reads a packaged extension's HRTF data from the resources path", async () => {
    env.isExtension = true;
    env.nodeEnv = "production";
    await loadHrtfData();
    expect(readPaths[0]).toBe("/packaged/resources/hrtf/hrtf-metadata.json");
  });
});
