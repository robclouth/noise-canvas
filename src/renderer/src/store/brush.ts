// createBrushSlice.ts
import { getParameterDef } from "@renderer/parameters";
import type { ZustandSet } from "./types";

export interface BrushState {
  brushIntensity: number;
  brushIterations: number;
  brushPan: number;
  brushEnvelopeDelayTime: number;
  brushEnvelopeAttackTime: number;
  brushEnvelopeSustainTime: number;
  brushEnvelopeReleaseTime: number;
  brushEnvelopeDelayPitch: number;
  brushEnvelopeAttackPitch: number;
  brushEnvelopeSustainPitch: number;
  brushEnvelopeReleasePitch: number;
  sourcePosition: { beats: number; pitch: number; fileId: string } | null;
  setSourcePosition: (position: { beats: number; pitch: number; fileId: string } | null) => void;
  sourcePositionMode: string;
  sourceDataMode: string;
  isSettingPosition: boolean;
  setIsSettingPosition: (value: boolean) => void;
  brushStartPosition: { beats: number; pitch: number } | null;
  setBrushStartPosition: (position: { beats: number; pitch: number } | null) => void;
  lockedOffset: { beats: number; pitch: number } | null;
  setLockedOffset: (offset: { beats: number; pitch: number } | null) => void;
  brushWrapMode: number;
  blendMode: number;
  algorithm: number;
}

export const createBrushSlice = (set: ZustandSet): BrushState => {
  return {
    brushWrapMode: getParameterDef("brushWrapMode").default,
    brushIntensity: getParameterDef("brushIntensity").default,
    brushIterations: getParameterDef("brushIterations").default,
    brushPan: getParameterDef("brushPan").default,
    brushEnvelopeDelayTime: getParameterDef("brushEnvelopeDelayTime").default,
    brushEnvelopeAttackTime: getParameterDef("brushEnvelopeAttackTime").default,
    brushEnvelopeSustainTime: getParameterDef("brushEnvelopeSustainTime").default,
    brushEnvelopeReleaseTime: getParameterDef("brushEnvelopeReleaseTime").default,
    brushEnvelopeDelayPitch: getParameterDef("brushEnvelopeDelayPitch").default,
    brushEnvelopeAttackPitch: getParameterDef("brushEnvelopeAttackPitch").default,
    brushEnvelopeSustainPitch: getParameterDef("brushEnvelopeSustainPitch").default,
    brushEnvelopeReleasePitch: getParameterDef("brushEnvelopeReleasePitch").default,
    blendMode: getParameterDef("blendMode").default,
    algorithm: getParameterDef("algorithm").default,
    sourcePositionMode: getParameterDef("sourcePositionMode").default,
    sourceDataMode: getParameterDef("sourceDataMode").default,
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
