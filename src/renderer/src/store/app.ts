import { getParameterDef } from "@renderer/parameters";
import { Vector2 } from "three";
import type { ZustandSet } from "./types";

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
}

export const createAppSlice = (set: ZustandSet): AppState => {
  return {
    displayMinDb: getParameterDef("displayMinDb").default,
    displayMaxDb: getParameterDef("displayMaxDb").default,
    magnitudeLimit: getParameterDef("magnitudeLimit").default,
    gridSizeBeats: getParameterDef("gridSizeBeats").default,
    gridSizeSemis: getParameterDef("gridSizeSemis").default,
    normalize: getParameterDef("normalize").default,
    scaleTonic: getParameterDef("scaleTonic").default,
    scaleType: getParameterDef("scaleType").default,
    bandsPerOctave: getParameterDef("bandsPerOctave").default,
    minFreq: getParameterDef("minFreq").default,

    mousePos: null,
    setMousePos: (mousePos) => set({ mousePos }),
    hoveredFile: null,
    setHoveredFile: (fileId) => set({ hoveredFile: fileId }),
  };
};
