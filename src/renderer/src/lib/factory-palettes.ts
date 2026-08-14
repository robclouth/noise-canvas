// The palettes that ship with the app: a working set of factory brushes per job.
import { makeBrushFromPreset } from "@renderer/store/brush-factory";
import { factoryPresets } from "./factory-presets";
import { CURRENT_PALETTE_VERSION, toStoredBrushes, type PaletteType } from "./palette-schema";

type FactoryPaletteSpec = {
  id: string;
  name: string;
  /** Factory preset ids, in the order the palette lists them. The first nine take keys 1–9. */
  presetIds: string[];
};

const SPECS: FactoryPaletteSpec[] = [
  {
    id: "factory-restoration",
    name: "Restoration",
    presetIds: ["eraser", "noise-gate", "restore", "high-pass", "compressor", "smudge"],
  },
  {
    id: "factory-breaks",
    name: "Breaks",
    presetIds: [
      "stamp",
      "jungle-stretch",
      "stutter",
      "rewind",
      "eraser",
      "reverse",
      "echo",
      "step-gate",
      "octave-down",
    ],
  },
  {
    id: "factory-vocals",
    name: "Vocals",
    presetIds: ["eraser", "noise-gate", "magnet", "compressor", "harmonics", "shimmer", "reverb", "stereo-widening"],
  },
  {
    id: "factory-from-scratch",
    name: "From Scratch",
    presetIds: ["paint-tone", "paint-noise", "stack", "crackle", "harmonics", "octave-up", "sampler", "convolution"],
  },
  {
    id: "factory-mixing",
    name: "Mixing",
    presetIds: ["booster", "compressor", "dynamic-bloom", "low-pass-sweep", "high-pass", "stereo-widening"],
  },
  {
    id: "factory-space",
    name: "Space",
    presetIds: ["reverb", "echo", "shimmer", "freeze", "3d-orbit", "stereo-widening"],
  },
  {
    id: "factory-mangle",
    name: "Mangle",
    presetIds: ["pixel-sort", "crush", "updraft", "flow", "smudge", "reverse", "octave-down", "morph"],
  },
];

function buildPalette(spec: FactoryPaletteSpec): PaletteType {
  const brushes = spec.presetIds
    .map((presetId) => {
      const preset = factoryPresets.find((candidate) => candidate.id === presetId);
      if (!preset) {
        console.warn(`Factory palette "${spec.name}" names a missing preset: ${presetId}`);
        return null;
      }
      return makeBrushFromPreset(preset, [], `${spec.id}-${presetId}`);
    })
    .filter((brush) => brush !== null);

  return {
    id: spec.id,
    name: spec.name,
    isFactory: true,
    version: CURRENT_PALETTE_VERSION,
    brushes: toStoredBrushes(brushes),
  };
}

export const factoryPalettes: PaletteType[] = SPECS.map(buildPalette).filter((palette) => palette.brushes.length > 0);
