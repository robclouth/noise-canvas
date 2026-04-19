import { BEAT_VALUES, PITCH_VALUES } from "@renderer/lib/constants";
import { getParameterDef } from "@renderer/parameters";
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
  scaleSnap: boolean;
  bandsPerOctave: number;
  minFreq: number;

  mousePos: Vector2 | null;
  setMousePos: (mousePos: Vector2 | null) => void;
  hoveredFile: string | null;
  setHoveredFile: (fileId: string | null) => void;
  sectionCollapsed: Record<string, boolean>;
  setSectionCollapsed: (label: string, collapsed: boolean) => void;
  cycleHorizontalGrid: (direction: 1 | -1) => void;
  cycleVerticalGrid: (direction: 1 | -1) => void;
  isZooming: boolean;
  setIsZooming: (isZooming: boolean) => void;
}

export const createAppSlice = (set: ZustandSet, get: ZustandGet): AppState => {
  return {
    displayMinDb: getParameterDef("displayMinDb").default,
    displayMaxDb: getParameterDef("displayMaxDb").default,
    magnitudeLimit: getParameterDef("magnitudeLimit").default,
    gridSizeBeats: getParameterDef("gridSizeBeats").default,
    gridSizeSemis: getParameterDef("gridSizeSemis").default,
    normalize: getParameterDef("normalize").default,
    scaleTonic: getParameterDef("scaleTonic").default,
    scaleType: getParameterDef("scaleType").default,
    scaleSnap: getParameterDef("scaleSnap").default,
    bandsPerOctave: getParameterDef("bandsPerOctave").default,
    minFreq: getParameterDef("minFreq").default,

    mousePos: null,
    setMousePos: (mousePos) => set({ mousePos }),
    hoveredFile: null,
    setHoveredFile: (fileId) => set({ hoveredFile: fileId }),
    sectionCollapsed: {},
    setSectionCollapsed: (label, collapsed) =>
      set((state) => ({
        sectionCollapsed: { ...state.sectionCollapsed, [label]: collapsed },
      })),
    cycleHorizontalGrid: (direction) => {
      const { gridSizeBeats } = get();
      const currentIndex = BEAT_VALUES.findIndex((v) => Math.abs(v.value - gridSizeBeats) < 0.0001);
      let nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = BEAT_VALUES.length - 1;
      if (nextIndex >= BEAT_VALUES.length) nextIndex = 0;
      set({ gridSizeBeats: BEAT_VALUES[nextIndex].value });
    },
    cycleVerticalGrid: (direction) => {
      const { gridSizeSemis } = get();
      const currentIndex = PITCH_VALUES.findIndex((v) => Math.abs(v.value - gridSizeSemis) < 0.0001);
      let nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = PITCH_VALUES.length - 1;
      if (nextIndex >= PITCH_VALUES.length) nextIndex = 0;
      set({ gridSizeSemis: PITCH_VALUES[nextIndex].value });
    },
    isZooming: false,
    setIsZooming: (isZooming) => set({ isZooming }),
  };
};
