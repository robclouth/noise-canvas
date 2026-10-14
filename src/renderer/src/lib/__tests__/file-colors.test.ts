import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the mocks used by managed-files.test.ts — without these the import
// chain pulls in the full zustand store which has init-time circular deps
// when loaded outside of an Electron renderer.
vi.mock("@renderer/effects", () => ({
  effects: {
    transform: {},
    dynamics: {},
    blur: {},
    synthesize: {},
    passthrough: {},
  },
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

vi.mock("../modals", () => ({
  openConfirm: vi.fn(),
  openContextModal: vi.fn(),
  openNewFilePrompt: vi.fn(),
  openInsertSilencePrompt: vi.fn(),
  openSetLengthPrompt: vi.fn(),
  openAddFilesAsLayersPrompt: vi.fn(),
  openReanalyzePrompt: vi.fn(),
}));

vi.mock("tone", () => ({
  Player: class {
    toDestination() {
      return this;
    }
  },
}));

vi.mock("@renderer/store", () => ({
  useStore: { getState: vi.fn() },
}));

import { getFileColor, getFileHue, openFiles, selectFileColor } from "../../store/files";
import { stackColor, type LayerStack } from "../../store/layers";

function openTestFiles(count: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `file_${i}`;
    const filePath = `/audio/take-0${i}.wav`;
    openFiles[id] = { id, filePath, displayName: `take-0${i}` };
    paths.push(filePath);
  }
  return paths;
}

/** Shortest way round the wheel between two hues, in degrees. */
function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

function closestPair(hues: number[]): number {
  let closest = 360;
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      closest = Math.min(closest, hueDistance(hues[i], hues[j]));
    }
  }
  return closest;
}

beforeEach(() => {
  for (const id of Object.keys(openFiles)) delete openFiles[id];
});

describe("file colours", () => {
  it("gives two files opposite hues", () => {
    const paths = openTestFiles(2);
    expect(hueDistance(getFileHue(paths[0]), getFileHue(paths[1]))).toBe(180);
  });

  it("keeps eight files at least 45 degrees apart", () => {
    const paths = openTestFiles(8);
    expect(closestPair(paths.map(getFileHue))).toBeGreaterThanOrEqual(45);
  });

  it("holds each file's hue as more files open", () => {
    const [first, second] = openTestFiles(2);
    const before = [getFileHue(first), getFileHue(second)];
    openTestFiles(6);
    expect([getFileHue(first), getFileHue(second)]).toEqual(before);
  });

  it("frees the hue of a closed file for a later one", () => {
    const paths = openTestFiles(4);
    const freed = getFileHue(paths[1]);
    delete openFiles["file_1"];
    openFiles["file_9"] = { id: "file_9", filePath: "/audio/new.wav", displayName: "new" };
    expect(getFileHue("/audio/new.wav")).toBe(freed);
  });

  it("hands a file that is not open a hue of its own", () => {
    expect(getFileColor("/audio/closed.wav")).toMatch(/^hsl\(\d+(\.\d+)?, 60%, 60%\)$/);
  });

  it("dresses every layer of a stack in the stack's colour", () => {
    openTestFiles(3);
    const group: LayerStack = {
      id: "g1",
      method: "nmf",
      label: "take — 3 parts",
      originId: "file_0",
      layerIds: ["file_0", "file_1", "file_2"],
      hue: 200,
      syncView: true,
      layout: "overlaid" as const,
    };
    const state = { layerStacks: { g1: group }, stackOfLayer: { file_0: "g1", file_1: "g1", file_2: "g1" } };
    for (const id of group.layerIds) expect(selectFileColor(state, id)).toBe(stackColor(200));
  });

  it("gives a file outside any group its own hue", () => {
    const paths = openTestFiles(2);
    const state = { layerStacks: {}, stackOfLayer: {} };
    expect(selectFileColor(state, "file_0")).toBe(getFileColor(paths[0]));
  });
});
