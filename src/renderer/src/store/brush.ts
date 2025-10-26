// createBrushSlice.ts
import { parameterDefs } from "@renderer/parameters";
import type { ZustandGet, ZustandSet } from "./types";

export interface BrushState {
  brushIntensity: number;
  brushIterations: number;
  brushPan: number;
  brushFeatherTime: number;
  brushFeatherPitch: number;
  brushFeatherSlopeTime: number;
  brushFeatherSlopePitch: number;
  sourcePosition: { beats: number; pitch: number; fileId: string } | null;
  setSourcePosition: (position: { beats: number; pitch: number; fileId: string } | null) => void;
  sourcePositionMode: string;
  isSettingPosition: boolean;
  setIsSettingPosition: (value: boolean) => void;
  brushStartPosition: { beats: number; pitch: number } | null;
  setBrushStartPosition: (position: { beats: number; pitch: number } | null) => void;
  lockedOffset: { beats: number; pitch: number } | null;
  setLockedOffset: (offset: { beats: number; pitch: number } | null) => void;
  brushWidthBeats: number;
  brushHeightSemis: number;
  brushSizeLockedToGrid: boolean;
  brushWrapMode: number;
  blendMode: number;
  algorithm: number;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const createBrushSlice = (set: ZustandSet, get: ZustandGet): BrushState => {
  return {
    brushWidthBeats: parameterDefs.brushWidthBeats.default,
    brushHeightSemis: parameterDefs.brushHeightSemis.default,
    brushSizeLockedToGrid: parameterDefs.brushSizeLockedToGrid.default,
    brushWrapMode: parameterDefs.brushWrapMode.default,
    brushIntensity: parameterDefs.brushIntensity.default,

    brushIterations: parameterDefs.brushIterations.default,
    brushPan: parameterDefs.brushPan.default,
    brushFeatherTime: parameterDefs.brushFeatherTime.default,
    brushFeatherPitch: parameterDefs.brushFeatherPitch.default,
    brushFeatherSlopeTime: parameterDefs.brushFeatherSlopeTime.default,
    brushFeatherSlopePitch: parameterDefs.brushFeatherSlopePitch.default,
    blendMode: parameterDefs.blendMode.default,
    algorithm: parameterDefs.algorithm.default,
    sourcePositionMode: parameterDefs.sourcePositionMode.default,
    sourcePosition: null,
    setSourcePosition: (position) => set({ sourcePosition: position, lockedOffset: null }),
    isSettingPosition: false,
    setIsSettingPosition: (value: boolean) => set({ isSettingPosition: value }),
    brushStartPosition: null,
    setBrushStartPosition: (position) => set({ brushStartPosition: position }),
    lockedOffset: null,
    setLockedOffset: (offset) => set({ lockedOffset: offset }),
  };
};
