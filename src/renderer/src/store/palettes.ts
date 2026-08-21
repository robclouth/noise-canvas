import { notifications } from "@mantine/notifications";
import { factoryPalettes } from "@renderer/lib/factory-palettes";
import { getFolders } from "@renderer/lib/folders";
import { host } from "@renderer/lib/host";
import { isBrushUnsaved } from "@renderer/lib/preset-schema";
import {
  CURRENT_PALETTE_VERSION,
  makePaletteId,
  paletteFingerprint,
  serializePalette,
  validatePalette,
  toStoredBrushes,
  type PaletteType,
} from "@renderer/lib/palette-schema";
import { produce } from "immer";
import { collectBrushReferencedPaths, openReferencedPaths } from "./files";
import { makeEmptyBrush } from "./brush-factory";
import { DEFAULT_PALETTE_ID, UNTITLED_PALETTE_NAME } from "./palette-id";
import type { Brush, State, ZustandGet, ZustandSet } from "./types";

/**
 * One palette open in the sidebar. The brushes it holds are the entries of
 * `brushes` whose `paletteId` is this `id` — the flat list stays the source of
 * truth, so every index-based reader keeps working.
 */
export type OpenPalette = {
  id: string;
  name: string;
  /** The `Palettes/` file this came from. Null means it was never saved. */
  libraryId: string | null;
  collapsed: boolean;
};

export interface PalettesState {
  palettesDir: string | null;
  availablePalettes: PaletteType[];
  openPalettes: OpenPalette[];
  initPalettes: () => Promise<void>;
  openPaletteFromLibrary: (libraryId: string) => void;
  addPalette: () => void;
  closePalette: (groupId: string) => void;
  renameOpenPalette: (groupId: string, name: string) => void;
  renameLibraryPalette: (libraryId: string, name: string) => Promise<void>;
  togglePaletteCollapsed: (groupId: string) => void;
  moveBrushToPalette: (brushId: string, toGroupId: string, toIndexInGroup: number) => void;
  movePalette: (fromIndex: number, toIndex: number) => void;
  savePalette: (groupId: string) => Promise<void>;
  savePaletteAs: (groupId: string, name: string) => Promise<void>;
  deletePaletteFromLibrary: (libraryId: string) => Promise<void>;
}

export function selectOpenPalette(state: State, groupId: string): OpenPalette | undefined {
  return state.openPalettes.find((palette) => palette.id === groupId);
}

/** The brushes in one group, in the order the flat list holds them. */
export function selectBrushesInPalette(state: State, groupId: string): Brush[] {
  return state.brushes.filter((brush) => brush.paletteId === groupId);
}

/**
 * True when a group's brushes differ from the file it was opened from. A group
 * that belongs to no file is dirty as soon as it holds a brush.
 */
export function isPaletteDirty(
  group: OpenPalette | undefined,
  brushesInPalette: readonly Brush[],
  availablePalettes: readonly PaletteType[],
): boolean {
  if (!group) return false;
  if (!group.libraryId) return brushesInPalette.length > 0;
  const saved = availablePalettes.find((palette) => palette.id === group.libraryId);
  if (!saved) return true;
  return paletteFingerprint(brushesInPalette) !== paletteFingerprint(saved.brushes);
}

export function selectPaletteDirty(state: State, groupId: string): boolean {
  return isPaletteDirty(
    selectOpenPalette(state, groupId),
    selectBrushesInPalette(state, groupId),
    state.availablePalettes,
  );
}

/** The brushes in a group that no library preset holds, or that differ from one. */
export function selectUnsavedBrushes(state: State, groupId: string): Brush[] {
  return selectBrushesInPalette(state, groupId).filter((brush) => isBrushUnsaved(brush, state.availablePresets));
}

/**
 * The flat brush indices the digit keys select, in key order: the first ten
 * brushes of the top palette.
 */
export function selectNumberKeyBrushIndices(state: State): number[] {
  const top = state.openPalettes[0];
  if (!top) return [];
  const indices: number[] = [];
  for (let i = 0; i < state.brushes.length && indices.length < 10; i++) {
    if (state.brushes[i].paletteId === top.id) indices.push(i);
  }
  return indices;
}

/** The group `Add brush` puts a new brush in: the one holding the active brush. */
export function selectTargetPaletteId(state: State): string | null {
  return state.brushes[state.activeBrushIndex]?.paletteId ?? state.openPalettes[0]?.id ?? null;
}

/** A palette named on a brush's row: enough to draw a tag, no more. */
export type PaletteTag = { id: string; name: string };

/**
 * Library preset id → the palettes holding a brush saved from it. Built once per
 * list rather than scanned per row.
 */
export function buildPresetPaletteIndex(palettes: readonly PaletteType[]): Map<string, PaletteTag[]> {
  const index = new Map<string, PaletteTag[]>();
  for (const palette of palettes) {
    const seen = new Set<string>();
    for (const brush of palette.brushes) {
      if (brush.libraryId === null || seen.has(brush.libraryId)) continue;
      seen.add(brush.libraryId);
      const tags = index.get(brush.libraryId);
      const tag: PaletteTag = { id: palette.id, name: palette.name };
      if (tags) tags.push(tag);
      else index.set(brush.libraryId, [tag]);
    }
  }
  return index;
}

/** The last flat index held by `groupId`, or -1 when the group is empty. */
function lastIndexOfGroup(brushes: readonly Brush[], groupId: string): number {
  for (let i = brushes.length - 1; i >= 0; i--) {
    if (brushes[i].paletteId === groupId) return i;
  }
  return -1;
}

/**
 * Where a brush landing at `indexInGroup` of `groupId` goes in the flat list.
 * An empty group inserts after the group before it, so a drop into an empty
 * palette does not send the brush to the end of the sidebar.
 */
export function flatInsertIndex(
  brushes: readonly Brush[],
  openPalettes: readonly OpenPalette[],
  groupId: string,
  indexInGroup: number,
): number {
  const members = brushes.map((brush, index) => ({ brush, index })).filter((e) => e.brush.paletteId === groupId);
  if (members.length > 0) {
    return indexInGroup >= members.length ? members[members.length - 1].index + 1 : members[indexInGroup].index;
  }

  const order = openPalettes.findIndex((palette) => palette.id === groupId);
  for (let i = order - 1; i >= 0; i--) {
    const tail = lastIndexOfGroup(brushes, openPalettes[i].id);
    if (tail >= 0) return tail + 1;
  }
  return 0;
}

function makeOpenPalette(name: string, libraryId: string | null): OpenPalette {
  return { id: crypto.randomUUID(), name, libraryId, collapsed: false };
}

async function writePalette(state: State, palette: PaletteType): Promise<string> {
  const dir = state.palettesDir ?? (await getFolders()).palettesDir;
  await host.fs.writeFile(host.path.join(dir, `${palette.id}.json`), serializePalette(palette), "utf-8");
  return dir;
}

function reportFailure(title: string, error: unknown) {
  console.error(title, error);
  notifications.show({
    title,
    message: error instanceof Error ? error.message : "Unknown error",
    color: "red",
  });
}

export const PALETTES_PERSISTED_KEYS = ["openPalettes"] as const;

/** The single untitled palette a store with no saved groups falls back to. */
export function makeDefaultPalette(): OpenPalette {
  return { id: DEFAULT_PALETTE_ID, name: UNTITLED_PALETTE_NAME, libraryId: null, collapsed: false };
}

export const createPalettesSlice = (set: ZustandSet, get: ZustandGet): PalettesState => ({
  palettesDir: null,
  availablePalettes: [...factoryPalettes],
  openPalettes: [makeDefaultPalette()],

  initPalettes: async () => {
    try {
      const { palettesDir } = await getFolders();
      const files = await host.fs.readdir(palettesDir);
      const userPalettes: PaletteType[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const contents = await host.fs.readFile(host.path.join(palettesDir, file), "utf-8");
          const result = validatePalette(JSON.parse(contents), file.replace(/\.json$/, ""));
          if (result.success) {
            userPalettes.push(result.data);
          } else {
            console.error(`Invalid palette file ${file}:`, result.errors);
            notifications.show({
              title: "Invalid palette",
              message: `Invalid palette ${file}`,
              color: "red",
              autoClose: 5000,
            });
          }
        } catch (error) {
          console.error(`Failed to load palette ${file}:`, error);
        }
      }

      set({ availablePalettes: [...factoryPalettes, ...userPalettes], palettesDir });
    } catch (error) {
      reportFailure("Error loading palettes", error);
    }
  },

  openPaletteFromLibrary: (libraryId: string) => {
    const state = get();
    const saved = state.availablePalettes.find((palette) => palette.id === libraryId);
    if (!saved) {
      notifications.show({ title: "Palette not found", message: `Palette ${libraryId} not found`, color: "red" });
      return;
    }

    const group = makeOpenPalette(saved.name, saved.id);
    // Cloned with fresh ids, so opening the same palette twice cannot collide
    // and editing a copy cannot write back into the library entry.
    const brushes: Brush[] = structuredClone(saved.brushes).map((brush) => ({
      ...brush,
      id: crypto.randomUUID(),
      paletteId: group.id,
      steps: brush.steps.map((step) => ({ ...step, id: crypto.randomUUID() })),
    }));

    set(
      produce((draft: State) => {
        draft.openPalettes.push(group);
        // An empty palette brings nothing to make active, so the current brush
        // stays selected rather than the index pointing past the list.
        if (brushes.length > 0) {
          draft.activeBrushIndex = draft.brushes.length;
          draft.brushes.push(...brushes);
          draft.activeStepIndex = 0;
        }
      }),
    );

    openReferencedPaths([...new Set(brushes.flatMap(collectBrushReferencedPaths))], get);
  },

  addPalette: () => {
    const state = get();
    const group = makeOpenPalette(UNTITLED_PALETTE_NAME, null);
    const brush = makeEmptyBrush(
      group.id,
      state.brushes.map((b) => b.color),
    );

    set(
      produce((draft: State) => {
        draft.openPalettes.push(group);
        draft.activeBrushIndex = draft.brushes.length;
        draft.brushes.push(brush);
        draft.activeStepIndex = 0;
      }),
    );
  },

  closePalette: (groupId: string) => {
    set(
      produce((draft: State) => {
        if (draft.openPalettes.length <= 1) return;
        // Every active-brush consumer reads brushes[activeBrushIndex], so the
        // list must never empty — the other palettes have to hold something.
        if (draft.brushes.every((brush) => brush.paletteId === groupId)) return;
        const active = draft.brushes[draft.activeBrushIndex];
        draft.openPalettes = draft.openPalettes.filter((palette) => palette.id !== groupId);
        draft.brushes = draft.brushes.filter((brush) => brush.paletteId !== groupId);
        const stillThere = active ? draft.brushes.indexOf(active) : -1;
        draft.activeBrushIndex = stillThere >= 0 ? stillThere : 0;
        draft.activeStepIndex = 0;
      }),
    );
  },

  renameOpenPalette: (groupId: string, name: string) => {
    set(
      produce((draft: State) => {
        const group = draft.openPalettes.find((palette) => palette.id === groupId);
        if (group) group.name = name;
      }),
    );

    // A group opened from a file carries the rename through to the file.
    const libraryId = selectOpenPalette(get(), groupId)?.libraryId;
    if (libraryId) void get().renameLibraryPalette(libraryId, name);
  },

  renameLibraryPalette: async (libraryId: string, name: string) => {
    const state = get();
    const saved = state.availablePalettes.find((palette) => palette.id === libraryId);
    if (!saved || saved.isFactory || saved.name === name) return;

    const updated: PaletteType = { ...saved, name };
    try {
      await writePalette(state, updated);
      set(
        produce((draft: State) => {
          draft.availablePalettes = draft.availablePalettes.map((p) => (p.id === libraryId ? updated : p));
          for (const open of draft.openPalettes) {
            if (open.libraryId === libraryId) open.name = name;
          }
        }),
      );
    } catch (error) {
      reportFailure("Rename failed", error);
    }
  },

  togglePaletteCollapsed: (groupId: string) => {
    set(
      produce((draft: State) => {
        const group = draft.openPalettes.find((palette) => palette.id === groupId);
        if (group) group.collapsed = !group.collapsed;
      }),
    );
  },

  moveBrushToPalette: (brushId: string, toGroupId: string, toIndexInGroup: number) => {
    set(
      produce((draft: State) => {
        const from = draft.brushes.findIndex((brush) => brush.id === brushId);
        if (from < 0) return;
        const active = draft.brushes[draft.activeBrushIndex];

        const [moved] = draft.brushes.splice(from, 1);
        moved.paletteId = toGroupId;
        draft.brushes.splice(flatInsertIndex(draft.brushes, draft.openPalettes, toGroupId, toIndexInGroup), 0, moved);

        const activeIndex = active ? draft.brushes.indexOf(active) : -1;
        if (activeIndex >= 0) draft.activeBrushIndex = activeIndex;
      }),
    );
  },

  movePalette: (fromIndex: number, toIndex: number) => {
    set(
      produce((draft: State) => {
        const palettes = draft.openPalettes;
        if (fromIndex < 0 || fromIndex >= palettes.length) return;
        const clamped = Math.min(Math.max(toIndex, 0), palettes.length - 1);
        if (clamped === fromIndex) return;
        const [moved] = palettes.splice(fromIndex, 1);
        palettes.splice(clamped, 0, moved);
      }),
    );
  },

  savePalette: async (groupId: string) => {
    const state = get();
    const group = selectOpenPalette(state, groupId);
    if (!group?.libraryId) return;

    const existing = state.availablePalettes.find((palette) => palette.id === group.libraryId);
    if (!existing) return;
    if (existing.isFactory) {
      notifications.show({
        title: "Cannot overwrite factory palette",
        message: "Use Save as… to save a copy.",
        color: "red",
      });
      return;
    }

    const updated: PaletteType = { ...existing, brushes: toStoredBrushes(selectBrushesInPalette(state, groupId)) };

    try {
      await writePalette(state, updated);
      set(
        produce((draft: State) => {
          draft.availablePalettes = draft.availablePalettes.map((p) => (p.id === updated.id ? updated : p));
        }),
      );
      notifications.show({ title: "Palette saved", message: `Saved over "${updated.name}"` });
    } catch (error) {
      reportFailure("Save failed", error);
    }
  },

  savePaletteAs: async (groupId: string, name: string) => {
    const state = get();
    const group = selectOpenPalette(state, groupId);
    if (!group) return;

    const palette: PaletteType = {
      id: makePaletteId(name, new Set(state.availablePalettes.map((p) => p.id))),
      name,
      isFactory: false,
      version: CURRENT_PALETTE_VERSION,
      brushes: toStoredBrushes(selectBrushesInPalette(state, groupId)),
    };

    try {
      const dir = await writePalette(state, palette);
      set(
        produce((draft: State) => {
          draft.availablePalettes.push(palette);
          draft.palettesDir = dir;
          const open = draft.openPalettes.find((p) => p.id === groupId);
          if (open) {
            open.libraryId = palette.id;
            open.name = name;
          }
        }),
      );
      notifications.show({ title: "Palette saved", message: `Saved as "${name}"` });
    } catch (error) {
      reportFailure("Save failed", error);
    }
  },

  deletePaletteFromLibrary: async (libraryId: string) => {
    const state = get();
    const palette = state.availablePalettes.find((candidate) => candidate.id === libraryId);
    if (!palette || palette.isFactory) return;

    try {
      const dir = state.palettesDir ?? (await getFolders()).palettesDir;
      await host.fs.unlink(host.path.join(dir, `${libraryId}.json`));
      set(
        produce((draft: State) => {
          draft.availablePalettes = draft.availablePalettes.filter((p) => p.id !== libraryId);
          // Anything open from it stays open; it just stops belonging to a file.
          for (const open of draft.openPalettes) {
            if (open.libraryId === libraryId) open.libraryId = null;
          }
        }),
      );
      notifications.show({ title: "Palette deleted", message: `Deleted "${palette.name}"` });
    } catch (error) {
      reportFailure("Delete failed", error);
    }
  },
});
