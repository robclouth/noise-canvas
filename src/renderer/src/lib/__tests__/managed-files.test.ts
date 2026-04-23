import { describe, expect, it, vi } from "vitest";

// Mirror the mocks used by recent-files.test.ts — without these the import
// chain pulls in the full zustand store which has init-time circular deps
// when loaded outside of an Electron renderer.
vi.mock("@renderer/effects", () => ({
  effects: {
    transform: {},
    dynamics: {},
    blur: {},
    overtones: {},
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
  openReanalyzePrompt: vi.fn(),
}));

// We deliberately do NOT mock ../history-manager — the @renderer/store mock
// below short-circuits its only init-time external dependency (useStore), so
// the real pruneOrphanHistoryDirs runs against the stubbed window.* below.
// Manager-instance functions (getHistoryManager etc.) used by files.ts are
// imported but never called by these tests.

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

import { isManagedFilePath, makeManagedFilePath } from "../../store/utils";
import { migrateBrushRefs, migrateRefsInPresetFiles, migrateRefsInSteps } from "../../store/files";
import { pruneOrphanHistoryDirs } from "../history-manager";
import type { Brush } from "../../store/types";
import type { EffectItem } from "../../effects/types";

// Tiny accessor that types the effects array (the Brush cast erases it to never[]).
function effectsOf(brush: Brush): EffectItem[] {
  return (brush.steps[0].effects ?? []) as EffectItem[];
}

// In-memory fs mock for pruneOrphanHistoryDirs. Records the directories that
// would be deleted on disk so we can assert the sweep targets only orphans.
type FakeFs = {
  readdirCalls: string[];
  rmCalls: string[];
  entries: string[];
};
function installFakeFs(entries: string[]): FakeFs {
  const fake: FakeFs = { readdirCalls: [], rmCalls: [], entries };
  // The vitest browser environment exposes a real Window we can't reassign,
  // but we CAN attach properties to it. The history module reads
  // window.ipcRenderer.invoke + window.nodePath.join + window.nodeFs.readdir/rm.
  const w = window as unknown as Record<string, unknown>;
  w.ipcRenderer = {
    invoke: vi.fn(async (channel: string) => {
      if (channel === "get-user-data-path") return "/userdata";
      return undefined;
    }),
  };
  w.nodePath = {
    join: (...parts: string[]) => parts.join("/"),
  };
  w.nodeFs = {
    readdir: vi.fn(async (dir: string) => {
      fake.readdirCalls.push(dir);
      if (dir === "/userdata/history") return [...fake.entries];
      throw new Error(`unexpected readdir: ${dir}`);
    }),
    rm: vi.fn(async (path: string) => {
      fake.rmCalls.push(path);
    }),
  };
  return fake;
}

describe("managed file path helpers", () => {
  it("makeManagedFilePath produces a managed:// sentinel for a fileId", () => {
    expect(makeManagedFilePath("file_123_abc")).toBe("managed://file_123_abc");
  });

  it("isManagedFilePath round-trips for managed paths", () => {
    const p = makeManagedFilePath("file_xyz");
    expect(isManagedFilePath(p)).toBe(true);
  });

  it("isManagedFilePath returns false for real on-disk paths", () => {
    expect(isManagedFilePath("/Users/rob/audio.wav")).toBe(false);
    expect(isManagedFilePath("audio.wav")).toBe(false);
    expect(isManagedFilePath("")).toBe(false);
  });

  it("isManagedFilePath does not match a path that merely contains the substring", () => {
    expect(isManagedFilePath("/Users/me/managed://whatever.wav")).toBe(false);
  });
});

// Build a minimal Brush with one step containing a top-level sourceFile ref
// AND a nested convolveIrFile inside a "convolve" effect — the two ref-storage
// shapes migrateBrushRefs needs to walk.
function makeBrush(sourcePath: string | null, irPath: string | null): Brush {
  return {
    id: "b1",
    name: "Test",
    color: { hue: "blue", variation: 0 },
    hotkey: null,
    libraryId: null,
    macroNames: ["", "", "", ""],
    macroValues: [0, 0, 0, 0],
    linkedParams: [],
    steps: [
      {
        id: "s1",
        name: "Step 1",
        sourceFile: sourcePath ? { path: sourcePath } : null,
        effects: [
          {
            id: "e1",
            effect: "convolve",
            enabled: true,
            params: { convolveIrFile: irPath ? { path: irPath } : null },
          },
        ],
      },
    ],
  } as unknown as Brush;
}

describe("migrateBrushRefs", () => {
  it("rewrites a top-level sourceFile ref whose path matches oldPath", () => {
    const brushes = [makeBrush("managed://file_x", null)];
    migrateBrushRefs(brushes, "managed://file_x", "/Users/rob/saved.wav");
    expect(brushes[0].steps[0].sourceFile).toEqual({ path: "/Users/rob/saved.wav" });
  });

  it("rewrites a nested effect param ref whose path matches oldPath", () => {
    const brushes = [makeBrush(null, "managed://file_y")];
    migrateBrushRefs(brushes, "managed://file_y", "/Users/rob/ir.wav");
    expect(effectsOf(brushes[0])[0].params!.convolveIrFile).toEqual({ path: "/Users/rob/ir.wav" });
  });

  it("leaves refs to a different path untouched", () => {
    const brushes = [makeBrush("/Users/rob/other.wav", "managed://different")];
    migrateBrushRefs(brushes, "managed://file_z", "/Users/rob/saved.wav");
    expect(brushes[0].steps[0].sourceFile).toEqual({ path: "/Users/rob/other.wav" });
    expect(effectsOf(brushes[0])[0].params!.convolveIrFile).toEqual({
      path: "managed://different",
    });
  });

  it("leaves null refs untouched", () => {
    const brushes = [makeBrush(null, null)];
    migrateBrushRefs(brushes, "managed://file_z", "/Users/rob/saved.wav");
    expect(brushes[0].steps[0].sourceFile).toBeNull();
    expect(effectsOf(brushes[0])[0].params!.convolveIrFile).toBeNull();
  });

  it("rewrites refs across many brushes / many steps in one walk", () => {
    const brushes = [
      makeBrush("managed://m1", "managed://m1"),
      makeBrush("managed://m2", null),
      makeBrush("managed://m1", "managed://m2"),
    ];
    migrateBrushRefs(brushes, "managed://m1", "/new/m1.wav");
    expect(brushes[0].steps[0].sourceFile).toEqual({ path: "/new/m1.wav" });
    expect(effectsOf(brushes[0])[0].params!.convolveIrFile).toEqual({ path: "/new/m1.wav" });
    expect(brushes[1].steps[0].sourceFile).toEqual({ path: "managed://m2" });
    expect(brushes[2].steps[0].sourceFile).toEqual({ path: "/new/m1.wav" });
    expect(effectsOf(brushes[2])[0].params!.convolveIrFile).toEqual({ path: "managed://m2" });
  });
});

describe("migrateRefsInSteps (preset shape)", () => {
  // A preset's steps array is shaped slightly differently from a Brush's
  // (top-level rather than nested under a Brush), but the per-step walker
  // is the same. This proves migrateRefsInSteps works directly on that
  // top-level shape — the basis of on-disk preset migration.
  it("rewrites a top-level sourceFile ref and reports changed=true", () => {
    const steps = [
      {
        id: "s1",
        name: "Step 1",
        sourceFile: { path: "managed://x" },
        effects: [],
      },
    ];
    const changed = migrateRefsInSteps(steps, "managed://x", "/new.wav");
    expect(changed).toBe(true);
    expect(steps[0].sourceFile).toEqual({ path: "/new.wav" });
  });

  it("returns false when nothing matches", () => {
    const steps = [{ id: "s1", name: "Step 1", sourceFile: { path: "/other.wav" }, effects: [] }];
    const changed = migrateRefsInSteps(steps, "managed://x", "/new.wav");
    expect(changed).toBe(false);
    expect(steps[0].sourceFile).toEqual({ path: "/other.wav" });
  });
});

describe("migrateRefsInPresetFiles", () => {
  // Sets up a fake fs with two preset JSON files plus an unrelated non-JSON
  // entry, returns inspection hooks for the writes that happen.
  function installPresetFs(files: Record<string, string>): {
    writes: Record<string, string>;
    readdirCalls: string[];
  } {
    const writes: Record<string, string> = {};
    const readdirCalls: string[] = [];
    const w = window as unknown as Record<string, unknown>;
    w.nodePath = {
      join: (...parts: string[]) => parts.join("/"),
    };
    w.nodeFs = {
      readdir: vi.fn(async (dir: string) => {
        readdirCalls.push(dir);
        return Object.keys(files);
      }),
      readFile: vi.fn(async (path: string) => {
        const name = path.split("/").pop()!;
        if (!(name in files)) throw new Error(`ENOENT: ${path}`);
        return files[name] as unknown;
      }),
      writeFile: vi.fn(async (path: string, content: string) => {
        writes[path] = content;
      }),
    };
    return { writes, readdirCalls };
  }

  it("rewrites refs and writes only files that actually changed", async () => {
    const presetA = JSON.stringify({
      id: "a",
      steps: [{ id: "s1", name: "S", sourceFile: { path: "managed://to-rename" }, effects: [] }],
    });
    const presetB = JSON.stringify({
      id: "b",
      steps: [{ id: "s1", name: "S", sourceFile: { path: "/unrelated.wav" }, effects: [] }],
    });
    const { writes } = installPresetFs({
      "a.json": presetA,
      "b.json": presetB,
      "readme.txt": "ignored",
    });
    await migrateRefsInPresetFiles("/presets", "managed://to-rename", "/new.wav");
    expect(Object.keys(writes)).toEqual(["/presets/a.json"]);
    const updatedA = JSON.parse(writes["/presets/a.json"]);
    expect(updatedA.steps[0].sourceFile).toEqual({ path: "/new.wav" });
  });

  it("rewrites refs nested inside an effect's params", async () => {
    const preset = JSON.stringify({
      id: "x",
      steps: [
        {
          id: "s1",
          name: "S",
          effects: [
            {
              id: "e1",
              effect: "convolve",
              enabled: true,
              params: { convolveIrFile: { path: "managed://ir" } },
            },
          ],
        },
      ],
    });
    const { writes } = installPresetFs({ "x.json": preset });
    await migrateRefsInPresetFiles("/presets", "managed://ir", "/new-ir.wav");
    const updated = JSON.parse(writes["/presets/x.json"]);
    expect(updated.steps[0].effects[0].params.convolveIrFile).toEqual({ path: "/new-ir.wav" });
  });

  it("does not throw when presetsDir does not exist", async () => {
    const w = window as unknown as Record<string, unknown>;
    w.nodeFs = {
      readdir: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    };
    await expect(migrateRefsInPresetFiles("/missing", "a", "b")).resolves.toBeUndefined();
  });

  it("a single corrupt JSON file does not block the others", async () => {
    const good = JSON.stringify({
      id: "g",
      steps: [{ id: "s1", name: "S", sourceFile: { path: "managed://x" }, effects: [] }],
    });
    const { writes } = installPresetFs({
      "good.json": good,
      "bad.json": "{ not valid json",
    });
    await migrateRefsInPresetFiles("/presets", "managed://x", "/new.wav");
    expect(Object.keys(writes)).toEqual(["/presets/good.json"]);
  });
});

describe("pruneOrphanHistoryDirs", () => {
  it("deletes only history dirs whose fileId is not in the active set", async () => {
    const fake = installFakeFs(["fileA", "fileB", "fileC"]);
    await pruneOrphanHistoryDirs(new Set(["fileA", "fileC"]));
    expect(fake.rmCalls).toEqual(["/userdata/history/fileB"]);
  });

  it("is a no-op when every entry is still active", async () => {
    const fake = installFakeFs(["fileA", "fileB"]);
    await pruneOrphanHistoryDirs(new Set(["fileA", "fileB"]));
    expect(fake.rmCalls).toEqual([]);
  });

  it("deletes every entry when the active set is empty", async () => {
    const fake = installFakeFs(["a", "b", "c"]);
    await pruneOrphanHistoryDirs(new Set());
    expect(fake.rmCalls.sort()).toEqual(["/userdata/history/a", "/userdata/history/b", "/userdata/history/c"]);
  });

  it("does not throw when the history root does not exist", async () => {
    const fake = installFakeFs([]);
    const w = window as unknown as { nodeFs: { readdir: ReturnType<typeof vi.fn> } };
    w.nodeFs.readdir = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    await expect(pruneOrphanHistoryDirs(new Set(["x"]))).resolves.toBeUndefined();
    expect(fake.rmCalls).toEqual([]);
  });
});
