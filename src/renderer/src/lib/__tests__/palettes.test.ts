import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocked before any other import, matching presets.test.ts. The registry is
// built from the real key list so a new effect cannot fail validation here.
vi.mock("@renderer/effects", async () => {
  const { EFFECT_KEYS } = await import("@renderer/effects/types");
  return { effects: Object.fromEntries(EFFECT_KEYS.map((key: string) => [key, {}])) };
});

vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));

vi.mock("@renderer/lib/folders", () => ({
  getFolders: vi.fn().mockResolvedValue({ palettesDir: "/mock/palettes" }),
}));

vi.mock("@renderer/store", () => ({ useStore: { getState: vi.fn() } }));

/** In-memory stand-in for the palettes folder. */
const disk = new Map<string, string>();

vi.mock("@renderer/lib/host", () => ({
  host: {
    fs: {
      readdir: vi.fn(async () => [...disk.keys()]),
      readFile: vi.fn(async (path: string) => {
        const contents = disk.get(path.replace("/mock/palettes/", ""));
        if (contents === undefined) throw new Error(`ENOENT ${path}`);
        return contents;
      }),
      writeFile: vi.fn(async (path: string, contents: string) => {
        disk.set(path.replace("/mock/palettes/", ""), contents);
      }),
      unlink: vi.fn(async (path: string) => {
        disk.delete(path.replace("/mock/palettes/", ""));
      }),
    },
    path: { join: (...parts: string[]) => parts.join("/") },
    env: { platform: "darwin" },
  },
}));

vi.mock("@renderer/store/files", () => ({
  openReferencedPaths: vi.fn(),
  collectBrushReferencedPaths: () => [],
}));

import { createDefaultStep } from "../../parameters";
import { makeDefaultPalette } from "../../store/palettes";
import {
  buildPresetPaletteIndex,
  createPalettesSlice,
  flatInsertIndex,
  selectBrushesInPalette,
  selectNumberKeyBrushIndices,
  selectPaletteDirty,
  selectTargetPaletteId,
  type OpenPalette,
} from "../../store/palettes";
import { DEFAULT_PALETTE_ID } from "../../store/palette-id";
import type { Brush, State } from "../../store/types";
import { factoryPalettes } from "../factory-palettes";
import { validatePalette } from "../palette-schema";

function makeBrush(name: string, paletteId = DEFAULT_PALETTE_ID, libraryId: string | null = null): Brush {
  return {
    id: crypto.randomUUID(),
    name,
    paletteId,
    color: { hue: "orange", variation: 0 },
    hotkey: null,
    steps: [createDefaultStep("Step 1")],
    linkedParams: [],
    libraryId,
    macroNames: ["Macro 1", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [50, 50, 50, 50],
  };
}

/** The real slice, wired to a plain object standing in for the zustand store. */
function createTestStore(initialBrushes: Brush[] = [makeBrush("Mock")], openPalettes?: OpenPalette[]) {
  let state = {
    brushes: initialBrushes,
    activeBrushIndex: 0,
    activeStepIndex: 0,
  } as unknown as State;

  const get = () => state;
  const set = (partial: Partial<State> | ((s: State) => Partial<State>)) => {
    state = { ...state, ...(typeof partial === "function" ? partial(state) : partial) } as State;
  };

  const slice = createPalettesSlice(set, get);
  state = { ...state, ...slice } as State;
  if (openPalettes) set({ openPalettes });

  return {
    slice,
    getState: () => state,
    setBrushes: (brushes: Brush[]) => set({ brushes }),
    /** The group that is not the default one, i.e. whatever was just opened. */
    lastGroup: () => state.openPalettes[state.openPalettes.length - 1],
  };
}

beforeEach(() => {
  disk.clear();
});

describe("factory palettes", () => {
  it("resolves every named preset into a brush", () => {
    expect(factoryPalettes).toHaveLength(7);
    for (const palette of factoryPalettes) {
      expect(palette.brushes.length).toBeGreaterThan(0);
      // A missing preset id would be dropped, leaving a short list.
      for (const brush of palette.brushes) expect(brush.libraryId).not.toBeNull();
    }
  });

  it("validates against the palette schema", () => {
    for (const palette of factoryPalettes) {
      const result = validatePalette(JSON.parse(JSON.stringify(palette)));
      expect(result.success, `${palette.name}: ${!result.success ? result.errors.join(", ") : ""}`).toBe(true);
    }
  });

  it("indexes each preset to the palettes holding it", () => {
    const index = buildPresetPaletteIndex(factoryPalettes);
    expect(index.get("eraser")?.map((tag) => tag.name)).toEqual(["Restoration", "Breaks", "Vocals"]);
    expect(index.get("stamp")?.map((tag) => tag.name)).toEqual(["Breaks"]);
  });
});

describe("flatInsertIndex", () => {
  const groups: OpenPalette[] = [
    { id: "a", name: "A", libraryId: null, collapsed: false },
    { id: "b", name: "B", libraryId: null, collapsed: false },
    { id: "c", name: "C", libraryId: null, collapsed: false },
  ];
  const brushes = [makeBrush("a1", "a"), makeBrush("a2", "a"), makeBrush("c1", "c")];

  it("places a brush inside its group", () => {
    expect(flatInsertIndex(brushes, groups, "a", 0)).toBe(0);
    expect(flatInsertIndex(brushes, groups, "a", 1)).toBe(1);
    expect(flatInsertIndex(brushes, groups, "a", 99)).toBe(2);
  });

  it("drops into an empty group after the group before it, not at the end", () => {
    expect(flatInsertIndex(brushes, groups, "b", 0)).toBe(2);
  });

  it("puts the first brush of a leading empty group at the front", () => {
    const trailingOnly = [makeBrush("c1", "c")];
    expect(flatInsertIndex(trailingOnly, groups, "a", 0)).toBe(0);
  });
});

describe("palettes slice", () => {
  it("starts with one untitled palette, which is never dirty", () => {
    const store = createTestStore();
    expect(store.getState().openPalettes).toEqual([makeDefaultPalette()]);
    expect(selectPaletteDirty(store.getState(), DEFAULT_PALETTE_ID)).toBe(false);
    expect(selectTargetPaletteId(store.getState())).toBe(DEFAULT_PALETTE_ID);
  });

  it("opens a palette as a new group beside the existing one", () => {
    const store = createTestStore();
    store.slice.openPaletteFromLibrary("factory-breaks");

    const state = store.getState();
    const source = factoryPalettes.find((p) => p.id === "factory-breaks")!;
    const group = store.lastGroup();

    expect(state.openPalettes).toHaveLength(2);
    expect(group.name).toBe("Breaks");
    expect(group.libraryId).toBe("factory-breaks");
    expect(selectBrushesInPalette(state, group.id).map((b) => b.name)).toEqual(source.brushes.map((b) => b.name));
    // The brush that was already open is untouched.
    expect(selectBrushesInPalette(state, DEFAULT_PALETTE_ID).map((b) => b.name)).toEqual(["Mock"]);
    expect(selectPaletteDirty(state, group.id)).toBe(false);
  });

  it("gives each opened copy its own ids, so the same palette can open twice", () => {
    const store = createTestStore();
    store.slice.openPaletteFromLibrary("factory-space");
    store.slice.openPaletteFromLibrary("factory-space");

    const brushes = store.getState().brushes;
    expect(new Set(brushes.map((b) => b.id)).size).toBe(brushes.length);
    expect(new Set(brushes.flatMap((b) => b.steps.map((s) => s.id))).size).toBe(
      brushes.reduce((n, b) => n + b.steps.length, 0),
    );
    // Editing one copy leaves the other, and the library entry, alone.
    const [first, second] = store.getState().openPalettes.slice(1);
    expect(selectPaletteDirty(store.getState(), first.id)).toBe(false);
    expect(selectPaletteDirty(store.getState(), second.id)).toBe(false);
  });

  it("does not write back into the library entry when a loaded brush is edited", () => {
    const store = createTestStore();
    store.slice.openPaletteFromLibrary("factory-mangle");
    const group = store.lastGroup();

    const brushes = store.getState().brushes.map((brush) => ({ ...brush }));
    const target = brushes.find((brush) => brush.paletteId === group.id)!;
    target.name = "Edited";
    store.setBrushes(brushes);

    expect(factoryPalettes.find((p) => p.id === "factory-mangle")!.brushes[0].name).not.toBe("Edited");
    expect(selectPaletteDirty(store.getState(), group.id)).toBe(true);
  });

  it("moves a brush between groups and keeps the active one selected", () => {
    const store = createTestStore();
    store.slice.openPaletteFromLibrary("factory-space");
    const group = store.lastGroup();

    const moving = store.getState().brushes.find((b) => b.paletteId === group.id)!;
    store.slice.moveBrushToPalette(moving.id, DEFAULT_PALETTE_ID, 0);

    const state = store.getState();
    expect(state.brushes.find((b) => b.id === moving.id)!.paletteId).toBe(DEFAULT_PALETTE_ID);
    expect(selectBrushesInPalette(state, DEFAULT_PALETTE_ID)[0].id).toBe(moving.id);
    expect(selectPaletteDirty(state, group.id)).toBe(true);
  });

  it("reorders the open palettes without touching the brushes", () => {
    const store = createTestStore();
    store.slice.openPaletteFromLibrary("factory-space");
    const before = store.getState().brushes.map((brush) => brush.id);
    const opened = store.lastGroup();

    store.slice.movePalette(1, 0);

    const state = store.getState();
    expect(state.openPalettes.map((palette) => palette.id)).toEqual([opened.id, DEFAULT_PALETTE_ID]);
    expect(state.brushes.map((brush) => brush.id)).toEqual(before);
  });

  it("leaves the order alone when a palette is dropped where it already is", () => {
    const store = createTestStore();
    store.slice.openPaletteFromLibrary("factory-space");
    const before = store.getState().openPalettes.map((palette) => palette.id);

    store.slice.movePalette(0, 0);
    store.slice.movePalette(5, 0);

    expect(store.getState().openPalettes.map((palette) => palette.id)).toEqual(before);
  });

  it("points the number keys at the top palette, following a reorder", () => {
    const store = createTestStore([makeBrush("Own A"), makeBrush("Own B")]);
    store.slice.openPaletteFromLibrary("factory-space");
    const opened = store.lastGroup();

    const brushes = store.getState().brushes;
    expect(selectNumberKeyBrushIndices(store.getState())).toEqual([0, 1]);

    store.slice.movePalette(1, 0);

    const openedIndices = brushes
      .map((brush, index) => ({ brush, index }))
      .filter((entry) => entry.brush.paletteId === opened.id)
      .map((entry) => entry.index)
      .slice(0, 10);
    expect(selectNumberKeyBrushIndices(store.getState())).toEqual(openedIndices);
  });

  it("refuses to overwrite a factory palette", async () => {
    const store = createTestStore();
    store.slice.openPaletteFromLibrary("factory-mixing");
    await store.slice.savePalette(store.lastGroup().id);
    expect(disk.size).toBe(0);
  });

  it("round-trips a saved palette through disk", async () => {
    const store = createTestStore([
      makeBrush("One", DEFAULT_PALETTE_ID, "eraser"),
      makeBrush("Two", DEFAULT_PALETTE_ID, "smudge"),
    ]);
    await store.slice.savePaletteAs(DEFAULT_PALETTE_ID, "Test Kit");

    expect(disk.size).toBe(1);
    expect(store.getState().openPalettes[0].name).toBe("Test Kit");
    expect(selectPaletteDirty(store.getState(), DEFAULT_PALETTE_ID)).toBe(false);

    // A fresh store reading the same folder gets the palette back intact, and
    // the stored brushes carry no group id.
    const reopened = createTestStore();
    await reopened.slice.initPalettes();
    const saved = reopened.getState().availablePalettes.find((p) => p.name === "Test Kit");
    expect(saved?.brushes.map((b) => b.name)).toEqual(["One", "Two"]);
    expect(saved?.brushes.every((b) => !("paletteId" in b))).toBe(true);
  });

  it("goes dirty on an edit and clean again on save", async () => {
    const store = createTestStore([makeBrush("One")]);
    await store.slice.savePaletteAs(DEFAULT_PALETTE_ID, "Kit");
    expect(selectPaletteDirty(store.getState(), DEFAULT_PALETTE_ID)).toBe(false);

    store.setBrushes([...store.getState().brushes, makeBrush("Two")]);
    expect(selectPaletteDirty(store.getState(), DEFAULT_PALETTE_ID)).toBe(true);

    await store.slice.savePalette(DEFAULT_PALETTE_ID);
    expect(selectPaletteDirty(store.getState(), DEFAULT_PALETTE_ID)).toBe(false);
  });

  it("closes a palette with its brushes, but never the last one", () => {
    const store = createTestStore();
    store.slice.openPaletteFromLibrary("factory-vocals");
    const group = store.lastGroup();

    store.slice.closePalette(group.id);
    expect(store.getState().openPalettes).toHaveLength(1);
    expect(store.getState().brushes.map((b) => b.name)).toEqual(["Mock"]);

    store.slice.closePalette(DEFAULT_PALETTE_ID);
    expect(store.getState().openPalettes).toHaveLength(1);
  });

  it("refuses to close the palette holding every remaining brush", () => {
    const store = createTestStore();
    store.slice.addPalette();
    const empty = store.lastGroup();

    // The second palette's own brush goes, leaving it empty but still open.
    store.setBrushes(store.getState().brushes.filter((brush) => brush.paletteId !== empty.id));
    expect(store.getState().openPalettes).toHaveLength(2);

    store.slice.closePalette(DEFAULT_PALETTE_ID);

    // Closing it would leave brushes empty, and every active-brush reader with
    // nothing to read.
    expect(store.getState().brushes.map((b) => b.name)).toEqual(["Mock"]);
    expect(store.getState().openPalettes).toHaveLength(2);
  });

  it("leaves a palette open and unlinked when its file is deleted", async () => {
    const store = createTestStore([makeBrush("Keep me")]);
    await store.slice.savePaletteAs(DEFAULT_PALETTE_ID, "Kit");
    const libraryId = store.getState().openPalettes[0].libraryId!;

    await store.slice.deletePaletteFromLibrary(libraryId);

    expect(disk.size).toBe(0);
    expect(store.getState().openPalettes[0].libraryId).toBeNull();
    expect(store.getState().brushes.map((b) => b.name)).toEqual(["Keep me"]);
  });

  it("carries a rename through to the file it came from", async () => {
    const store = createTestStore([makeBrush("One")]);
    await store.slice.savePaletteAs(DEFAULT_PALETTE_ID, "Kit");
    const libraryId = store.getState().openPalettes[0].libraryId!;

    await store.slice.renameLibraryPalette(libraryId, "Renamed");

    expect(store.getState().openPalettes[0].name).toBe("Renamed");
    expect(JSON.parse(disk.get(`${libraryId}.json`)!).name).toBe("Renamed");
  });
});
