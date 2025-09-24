import { atom, createStore } from "jotai";
import { atomWithStorage, splitAtom } from "jotai/utils";
import { RefObject } from "react";
import { Vector2 } from "three";
import { FileRendererHandle } from "./components/file-renderer";
import type { OpenFile, SpectrogramData } from "./types";

export const store = createStore();

export const rendererRefs: Record<string, RefObject<FileRendererHandle | null>> = {};

export const openFilesAtom = atom<OpenFile[]>([]);
export const openFileAtomsAtom = splitAtom(openFilesAtom);

export const filesBpmAtom = atomWithStorage<Record<string, number>>("filesBpm", {}, undefined, { getOnInit: true });

export const fileBpmAtom = (filePath: string) =>
  atom(
    (get) => get(filesBpmAtom)[filePath] || 120,
    (get, set, newBpm: number) => {
      set(filesBpmAtom, (currentBpms) => ({
        ...currentBpms,
        [filePath]: newBpm,
      }));
    },
  );

export const activeFilePathAtom = atom<string | null>(null);
export const activeFileAtom = atom<OpenFile | null>((get) => {
  const activeFilePath = get(activeFilePathAtom);
  const openFiles = get(openFilesAtom);
  return openFiles.find((f) => f.filePath === activeFilePath) ?? null;
});

export const sourceFilePathAtom = atomWithStorage<string | null>("sourceFilePath", null, undefined, {
  getOnInit: true,
});

export const sourceFileAtom = atom<OpenFile | null>((get) => {
  const sourceFilePath = get(sourceFilePathAtom);
  if (!sourceFilePath) return get(activeFileAtom);
  const openFiles = get(openFilesAtom);
  return openFiles.find((f) => f.filePath === sourceFilePath) ?? null;
});

export const audioBufferAtom = atom<AudioBuffer | null>((get) => {
  const activeFile = get(activeFileAtom);
  return activeFile?.audioBuffer ?? null;
});

export const spectrogramDataAtom = atom<SpectrogramData | null>((get) => {
  const activeFile = get(activeFileAtom);
  return activeFile?.spectrogramData ?? null;
});

// Is audio currently playing?
export const isPlayingAtom = atom(false);
export const loopAtom = atom(false);

// Brush type - The default is just a string.
// The App component will be responsible for validating it.
export const brushTypeAtom = atomWithStorage<string>("brushType", "gain", undefined, { getOnInit: true });

// Brush dimensions
export const brushWidthAtom = atomWithStorage("brushWidth", 0.25, undefined, { getOnInit: true }); // in beats
export const brushHeightAtom = atomWithStorage("brushHeight", 1, undefined, { getOnInit: true }); // in semitones
export const brushSizeLockedToGridAtom = atomWithStorage("brushSizeLockedToGrid", true, undefined, { getOnInit: true });

// Controls whether the output of the synthesis is normalized
export const normalizeAtom = atomWithStorage("normalize", true, undefined, { getOnInit: true });

// Brush snapping
export const gridSizeAtom = atomWithStorage("gridSize", 0.25, undefined, { getOnInit: true }); // in beats
export const gridSizeYAtom = atomWithStorage("gridSizeY", 1, undefined, { getOnInit: true }); // in semitones

export const zoomPowerAtom = atomWithStorage("zoomPower", 0, undefined, { getOnInit: true });
export const scrollAtom = atom(0);

export const featherXAtom = atomWithStorage("featherX", 0, undefined, { getOnInit: true });
export const featherYAtom = atomWithStorage("featherY", 0, undefined, { getOnInit: true });

export const brushIntensityAtom = atomWithStorage("brushIntensity", 100, undefined, { getOnInit: true });
export const brushIntensityModAtom = atomWithStorage("brushIntensityMod", 0, undefined, {
  getOnInit: true,
});
export const panAtom = atomWithStorage("pan", 0.0, undefined, { getOnInit: true });

export const scaleTonicAtom = atomWithStorage("scaleTonic", "C", undefined, { getOnInit: true });
export const scaleTypeAtom = atomWithStorage("scaleType", "major", undefined, { getOnInit: true });

export const offsetXAtom = atomWithStorage("offsetX", 0.0, undefined, { getOnInit: true });
export const offsetYAtom = atomWithStorage("offsetY", 0.0, undefined, { getOnInit: true });
export const offsetLockAtom = atomWithStorage("offsetLock", false, undefined, { getOnInit: true });

export const mousePosAtom = atom<Vector2 | null>(null);

export const bandsPerOctaveAtom = atomWithStorage("bandsPerOctave", 24, undefined, { getOnInit: true });
export const minFreqAtom = atomWithStorage("minFreq", 8.1758, undefined, { getOnInit: true }); // MIDI note 0

export const blendModeAtom = atomWithStorage<
  "Normal" | "Maximum" | "Minimum" | "Dissolve" | "Multiply" | "Difference" | "Subtract" | "Divide"
>("blendMode", "Normal", undefined, {
  getOnInit: true,
});

// Modulator

export const modulatorModeAtom = atomWithStorage<number>("modulatorMode", 0, undefined, { getOnInit: true });
export const modulatorPatternShapeAtom = atomWithStorage<number>("modulatorPatternShape", 0, undefined, {
  getOnInit: true,
});
export const modulatorPatternRateBeatsAtom = atomWithStorage("modulatorPatternRateBeats", 1, undefined, {
  getOnInit: true,
});
export const modulatorPatternRateCentsAtom = atomWithStorage("modulatorPatternRateCents", 0, undefined, {
  getOnInit: true,
});
export const modulatorPatternRadialAtom = atomWithStorage("modulatorPatternRadial", false, undefined, {
  getOnInit: true,
});
