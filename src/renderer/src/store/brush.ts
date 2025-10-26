// createBrushSlice.ts
import { getParameterDef } from "@renderer/parameters";
import type { ZustandSet } from "./types";

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
export const createBrushSlice = (set: ZustandSet): BrushState => {
  return {
    brushWidthBeats: getParameterDef("brushWidthBeats").default,
    brushHeightSemis: getParameterDef("brushHeightSemis").default,
    brushSizeLockedToGrid: getParameterDef("brushSizeLockedToGrid").default,
    brushWrapMode: getParameterDef("brushWrapMode").default,
    brushIntensity: getParameterDef("brushIntensity").default,
    brushIterations: getParameterDef("brushIterations").default,
    brushPan: getParameterDef("brushPan").default,
    brushFeatherTime: getParameterDef("brushFeatherTime").default,
    brushFeatherPitch: getParameterDef("brushFeatherPitch").default,
    brushFeatherSlopeTime: getParameterDef("brushFeatherSlopeTime").default,
    brushFeatherSlopePitch: getParameterDef("brushFeatherSlopePitch").default,
    blendMode: getParameterDef("blendMode").default,
    algorithm: getParameterDef("algorithm").default,
    sourcePositionMode: getParameterDef("sourcePositionMode").default,
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
