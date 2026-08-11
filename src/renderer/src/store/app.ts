import { BEAT_VALUES, ONSETS_GRID_VALUE, PITCH_VALUES } from "@renderer/lib/constants";
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

export const APP_PERSISTED_KEYS = ["uiSize", "walkthroughSeen"] as const;

export interface AppState {
  uiSize: UiSize;
  setUiSize: (uiSize: UiSize) => void;
  toggleUiSize: () => void;

  // Set once the first-run walkthrough has been offered, so it is only ever
  // proposed unprompted on a genuinely fresh install.
  walkthroughSeen: boolean;
  setWalkthroughSeen: (seen: boolean) => void;

  // The manual heading the viewer is open at, or null when it is closed.
  // Opening at a section is how every deep link into the manual works.
  manualSection: string | null;
  openManual: (section?: string) => void;
  closeManual: () => void;

  // True while the discoverability overlay is outlining every area at once.
  helpOverlayOpen: boolean;
  setHelpOverlayOpen: (open: boolean) => void;

  displayMinDb: number;
  displayMaxDb: number;
  magnitudeLimit: number;
  gridSizeBeats: number;
  gridSizeSemis: number;
  gridSwing: number;
  snapTime: boolean;
  snapPitch: boolean;
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
    walkthroughSeen: false,
    setWalkthroughSeen: (walkthroughSeen) => set({ walkthroughSeen }),
    manualSection: null,
    // An empty section still opens the viewer; it just lands at the top.
    openManual: (section) => set({ manualSection: section ?? "", helpOverlayOpen: false }),
    closeManual: () => set({ manualSection: null }),
    helpOverlayOpen: false,
    setHelpOverlayOpen: (helpOverlayOpen) => set({ helpOverlayOpen }),
    displayMinDb: getParameterDef("displayMinDb").default,
    displayMaxDb: getParameterDef("displayMaxDb").default,
    magnitudeLimit: getParameterDef("magnitudeLimit").default,
    gridSizeBeats: getParameterDef("gridSizeBeats").default,
    gridSizeSemis: getParameterDef("gridSizeSemis").default,
    gridSwing: getParameterDef("gridSwing").default,
    snapTime: getParameterDef("snapTime").default,
    snapPitch: getParameterDef("snapPitch").default,
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
      // Onsets sits below the smallest beat value as the grid's bottom stop.
      const values = [ONSETS_GRID_VALUE, ...BEAT_VALUES.map((v) => v.value)];
      const { gridSizeBeats } = get();
      const currentIndex = values.findIndex((v) => Math.abs(v - gridSizeBeats) < 0.0001);
      let nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = values.length - 1;
      if (nextIndex >= values.length) nextIndex = 0;
      set({ gridSizeBeats: values[nextIndex] });
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
