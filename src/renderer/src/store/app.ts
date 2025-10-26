import { parameterDefs } from "@renderer/parameters";
import { Vector2 } from "three";
import type { ZustandGet, ZustandSet } from "./types";

export interface AppState {
  displayMinDb: number;
  displayMaxDb: number;
  magnitudeLimit: number;
  gridSizeBeats: number;
  gridSizeSemis: number;
  normalize: boolean;
  scaleTonic: string;
  scaleType: string;
  bandsPerOctave: number;
  minFreq: number;

  mousePos: Vector2 | null;
  setMousePos: (mousePos: Vector2 | null) => void;
  hoveredFile: string | null;
  setHoveredFile: (fileId: string | null) => void;
  sectionCollapsed: Record<string, boolean>;
  setSectionCollapsed: (section: string, collapsed: boolean) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const createAppSlice = (set: ZustandSet, get: ZustandGet): AppState => {
  return {
    displayMinDb: parameterDefs.displayMinDb.default,
    displayMaxDb: parameterDefs.displayMaxDb.default,
    magnitudeLimit: parameterDefs.magnitudeLimit.default,
    gridSizeBeats: parameterDefs.gridSizeBeats.default,
    gridSizeSemis: parameterDefs.gridSizeSemis.default,
    normalize: parameterDefs.normalize.default,
    scaleTonic: parameterDefs.scaleTonic.default,
    scaleType: parameterDefs.scaleType.default,
    bandsPerOctave: parameterDefs.bandsPerOctave.default,
    minFreq: parameterDefs.minFreq.default,

    // ---------------- Plain state fields ----------------
    mousePos: null,
    setMousePos: (mousePos) => set({ mousePos }),
    hoveredFile: null,
    setHoveredFile: (fileId) => set({ hoveredFile: fileId }),
    sectionCollapsed: {},
    setSectionCollapsed: (section, collapsed) =>
      set((state) => ({
        sectionCollapsed: { ...state.sectionCollapsed, [section]: collapsed },
      })),
  };
};
