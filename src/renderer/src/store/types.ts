import type { CoarseStrip } from "../lib/coarse-strip";
import type { FileRendererHandle } from "@renderer/components/file-renderer";
import type { BrushStep } from "@renderer/parameters";
import type { OutputLevels } from "@renderer/lib/output-levels";
import type { Vector2 } from "three";
import type { AppState } from "./app";
import type { AudioState } from "./audio";
import type { BrushState } from "./brush";
import type { EffectsState } from "./effects";
import type { FilesState } from "./files";
import type { FillState } from "./fill";
import type { SelectionAuditionState } from "./selection-audition";
import type { SelectionClipboardState } from "./selection-clipboard";
import type { SelectionRippleState } from "./selection-ripple";
import { ModulatorsState } from "./modulators";
import type { LinkState } from "./link";
import type { PalettesState } from "./palettes";
import type { PresetsState } from "./presets";
import type { SectionPresetsState } from "./section-presets";
import type { LayerStacksState } from "./layers";
import type { StepsState } from "./steps";

export type BrushColor = {
  hue: string;
  variation: number;
};

export type Brush = {
  id: string;
  name: string;
  /** The open palette holding this brush, keyed by `OpenPalette.id`. */
  paletteId: string;
  color: BrushColor;
  hotkey: string | null;
  steps: BrushStep[];
  linkedParams: string[];
  libraryId: string | null;
  macroNames: string[];
  macroValues: number[];
};

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
  // The analysed packed state. Present only between analysis and the first
  // texture upload: the renderer releases it once the GPU holds the state,
  // and from then on the FBO and the block store carry it.
  packedData?: Float32Array;
  // The whole file at one coarser display level, kept by the analysis of a
  // file the canvas cannot hold. Shows while the display is drawn from the
  // store, and is released with `packedData`.
  coarseStrip?: CoarseStrip;
  // The synthesis inverse map. Released with `packedData` once the GPU holds
  // it; rebuilt in milliseconds from the band layout when a derived file or a
  // reopen needs it again.
  inverseMap?: Float32Array;
  /** The band layout, four per band; `metadataTextureRows` makes the texture the shaders read. */
  metadata: Float64Array;
  /** Packed coefficients the file holds: the sum of the band lengths, with no padding. */
  texels: number;
  numFrames: number;
  numBands: number;
  numChannels: number;
  sampleRate: number;
  packedTextureSize: Vector2;
  minFreq: number;
  bandsPerOctave: number;
  // Sum of squared magnitudes over every stored coefficient, from analysis.
  // Used to derive the Convolve effect's IR-normalization scalar. Absent on
  // FBO-derived spectrograms (duplicates, stem splits) that never re-analyze.
  magnitudeEnergy?: number;
  synthesisMetadata: {
    bandOffsets: Uint32Array;
    bandStepLog2s: Int32Array;
    bandLengths: Uint32Array;
  };
};

export type OpenFile = {
  id: string;
  // For real files: an absolute on-disk path. For managed files: a stable
  // `managed://<fileId>` sentinel so the same path-keyed maps (filepathsBpm,
  // brush sourceFile refs, getFileColor, etc.) work uniformly. Save As swaps
  // the sentinel for the chosen real path and migrates those maps.
  filePath: string;
  // Human-readable label. Derived from basename(filePath) for real files;
  // assigned (e.g. "Untitled 1") for managed files.
  displayName: string;
  spectrogramData?: SpectrogramData;
  audioBuffer?: AudioBuffer;
  audioPeak?: number;
  // Gain reduction the last stroke's limiting applied (dB per 5 ms hop over
  // the window it rebuilt) and its peak.
  gainReductionDb?: Float32Array;
  maxGainReductionDb?: number;
  // Peak level per 5 ms hop over the whole buffer, and where it overloads.
  // A commit measures the window it rebuilt and splices it in.
  outputLevels?: OutputLevels;
  // Detected onsets as flat [timeSec, salience] pairs, from analysis and
  // refreshed by synthesis so they follow what has been painted. Raw and
  // unthresholded — lib/onset-map.ts applies the sensitivity control.
  onsets?: Float32Array;
  // What the last pass over the whole file found: the level that counts as
  // silence, and each band's loudest moment. Carried so a stroke can re-detect
  // its own span alone and still judge it on the file's terms. Absent until a
  // whole-file pass has run, which makes the next detection a whole-file one.
  onsetReference?: { odfMax: number; bandMax: Float32Array };
  // Set by a stroke committed with re-analysis off, whose coefficients stay as
  // painted rather than as the audio analyses. The next projecting stroke
  // rebuilds the whole file to clear it, so the picture holds together.
  unprojectedPaint?: boolean;
  // The lane is minimized and the renderer's GPU state is released.
  parked?: boolean;
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
  end: number; // seconds from start of file
};

export type State = BrushState &
  EffectsState &
  ModulatorsState &
  FilesState &
  AudioState &
  AppState &
  PresetsState &
  PalettesState &
  SectionPresetsState &
  StepsState &
  LinkState &
  FillState &
  LayerStacksState &
  SelectionAuditionState &
  SelectionClipboardState &
  SelectionRippleState & {
    setParameter: (key: ParameterKey, value: unknown, effectId?: string) => void;
    randomizationAmounts: Record<string, number>;
    setRandomizationAmount: (key: string, amount: number) => void;
    excludedFromRandomization: string[];
    setParamExcluded: (key: ParameterKey, excluded: boolean) => void;
    setParamLinked: (key: ParameterKey, linked: boolean, effectId?: string) => void;
  };

// Helper type to extract parameter keys from state
export type ParameterKey = keyof State;

export type ZustandSet = (partial: State | Partial<State> | ((state: State) => State | Partial<State>)) => void;
export type ZustandGet = () => State;
