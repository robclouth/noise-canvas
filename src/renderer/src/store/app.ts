import { BEAT_VALUES, PITCH_VALUES } from "@renderer/lib/constants";
import { getParameterDef } from "@renderer/parameters";
import { Vector2 } from "three";
import type { ZustandGet, ZustandSet } from "./types";

// Global UI density token. Doubles as the Mantine `size` token for components
// whose size prop should track density (e.g. "md" = normal, "sm" = compact).
export type UiSize = "md" | "sm";

// Initial density used on first run (before any persisted value). The Ableton
// extension build sets VITE_DEFAULT_UI_SIZE=sm so compact is the out-of-the-box
// default there; runtime code can still change it via setUiSize().
const envUiSize = import.meta.env.VITE_DEFAULT_UI_SIZE;
export const DEFAULT_UI_SIZE: UiSize = envUiSize === "sm" || envUiSize === "md" ? envUiSize : "md";

export const APP_PERSISTED_KEYS = ["uiSize"] as const;

export interface AppState {
  uiSize: UiSize;
  setUiSize: (uiSize: UiSize) => void;
  toggleUiSize: () => void;

  displayMinDb: number;
  displayMaxDb: number;
  magnitudeLimit: number;
  gridSizeBeats: number;
  gridSizeSemis: number;
  gridSwing: number;
  snapTime: boolean;
  snapPitch: boolean;
  normalize: boolean;
  scaleTonic: string;
  scaleType: string;
  bandsPerOctave: number;
  minFreq: number;

  mousePos: Vector2 | null;
  setMousePos: (mousePos: Vector2 | null) => void;
  sectionCollapsed: Record<string, boolean>;
  setSectionCollapsed: (label: string, collapsed: boolean) => void;
  cycleHorizontalGrid: (direction: 1 | -1) => void;
  cycleVerticalGrid: (direction: 1 | -1) => void;
  isZooming: boolean;
  setIsZooming: (isZooming: boolean) => void;
}

export const createAppSlice = (set: ZustandSet, get: ZustandGet): AppState => {
  return {
    uiSize: DEFAULT_UI_SIZE,
    setUiSize: (uiSize) => set({ uiSize }),
    toggleUiSize: () => set((state) => ({ uiSize: state.uiSize === "md" ? "sm" : "md" })),
    displayMinDb: getParameterDef("displayMinDb").default,
    displayMaxDb: getParameterDef("displayMaxDb").default,
    magnitudeLimit: getParameterDef("magnitudeLimit").default,
    gridSizeBeats: getParameterDef("gridSizeBeats").default,
    gridSizeSemis: getParameterDef("gridSizeSemis").default,
    gridSwing: getParameterDef("gridSwing").default,
    snapTime: getParameterDef("snapTime").default,
    snapPitch: getParameterDef("snapPitch").default,
    normalize: getParameterDef("normalize").default,
    scaleTonic: getParameterDef("scaleTonic").default,
    scaleType: getParameterDef("scaleType").default,
    bandsPerOctave: getParameterDef("bandsPerOctave").default,
    minFreq: getParameterDef("minFreq").default,

    mousePos: null,
    setMousePos: (mousePos) => set({ mousePos }),
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
