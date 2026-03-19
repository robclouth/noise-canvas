import type { FileRendererHandle } from "@renderer/components/file-renderer";
import type { Vector2 } from "three";
import type { AppState } from "./app";
import type { AudioState } from "./audio";
import type { BrushState } from "./brush";
import type { EffectsState } from "./effects";
import type { FilesState } from "./files";
import { ModulatorsState } from "./modulators";
import type { PresetsState } from "./presets";
import type { StepsState } from "./steps";

export type SliderScale = "linear" | "log" | "logBipolar";

export type SliderMark = { value: number; label: string };

export type FileSettings = {
  bpm: number;
  bandsPerOctave: number;
  zoom: number;
  offset: number;
  playbackStartTime: number;
};

export type SpectrogramData = {
  packedData: Float32Array;
  inverseMap: Float32Array;
  metadata: Float32Array;
  textureWidth: number;
  textureHeight: number;
  numFrames: number;
  numBands: number;
  numChannels: number;
  sampleRate: number;
  packedTextureSize: Vector2;
  minFreq: number;
  bandsPerOctave: number;
  synthesisMetadata: {
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  };
};

export type OpenFile = {
  id: string;
  filePath: string;
  spectrogramData?: SpectrogramData;
  audioBuffer?: AudioBuffer;
  audioPeak?: number;
  rendererRef?: React.RefObject<FileRendererHandle | null>;
};

export type PlayerClock = {
  startAt: number | null; // Tone.now() when (re)started
  startOffset: number; // seconds into buffer at (re)start
  loopStart: number; // active loop start
  loopEnd: number; // active loop end
};

export type LoopRegion = {
  start: number; // seconds from start of file
  end: number;   // seconds from start of file
};

export type State = BrushState &
  EffectsState &
  ModulatorsState &
  FilesState &
  AudioState &
  AppState &
  PresetsState &
  StepsState & {
    setParameter: (key: ParameterKey, value: unknown, effectId?: string) => void;
    randomizationAmounts: Record<string, number>;
    setRandomizationAmount: (key: string, amount: number) => void;
    excludedFromRandomization: string[];
    setParamExcluded: (key: ParameterKey, excluded: boolean) => void;
    setParamLinked: (key: ParameterKey, linked: boolean) => void;
  };

// Helper type to extract parameter keys from state
export type ParameterKey = keyof State;

export type ZustandSet = (partial: State | Partial<State> | ((state: State) => State | Partial<State>)) => void;
export type ZustandGet = () => State;
