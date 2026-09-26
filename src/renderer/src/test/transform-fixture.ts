import { commands } from "@vitest/browser/context";
import { packedTextureSizeOf } from "../lib/canvas-view";
import type { State } from "../store/types";
import { PARITY_FILE_PATH, type ParityData } from "./canvas-parity";
import { createStateForEffects } from "./render-harness";

/** Where `scripts/transform-fixture.mjs` writes its analysis, and the transform tests keep what they record. */
export const TRANSFORM_FIXTURE_DIR = ".cache/transform-golden";

/** An analysed file as the transform tests paint it: its band layout, onsets and packed coefficients. */
export type TransformFixture = {
  sampleRate: number;
  bandsPerOctave: number;
  minFreq: number;
  numFrames: number;
  numBands: number;
  texels: number;
  bandOffsets: number[];
  bandLengths: number[];
  bandStepLog2s: number[];
  bandFreqsHz: number[];
  /** Four per band: offset, length, step log2, centre frequency. */
  metadata: number[];
  /** Flat [time, strength] pairs. */
  onsets: number[];
  packed: Float32Array;
};

export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The analysis `scripts/transform-fixture.mjs` wrote. */
export async function loadTransformFixture(): Promise<TransformFixture> {
  const layout: Omit<TransformFixture, "packed"> = JSON.parse(
    await commands.readFile(`${TRANSFORM_FIXTURE_DIR}/fixture.json`),
  );
  const bytes = decodeBase64(await commands.readFile(`${TRANSFORM_FIXTURE_DIR}/fixture.bin`, "base64"));
  return { ...layout, packed: new Float32Array(bytes.buffer) };
}

/** A fixture as parity data, with its own copy of the coefficients each call. */
export function parityDataOf(fixture: TransformFixture): ParityData {
  const inverseMap = new Float32Array(fixture.texels * 2);
  for (let band = 0; band < fixture.numBands; band++) {
    const step = 2 ** fixture.bandStepLog2s[band];
    for (let k = 0; k < fixture.bandLengths[band]; k++) {
      const at = fixture.bandOffsets[band] + k;
      inverseMap[at * 2] = k * step;
      inverseMap[at * 2 + 1] = band;
    }
  }
  return {
    packedData: fixture.packed.slice(),
    inverseMap,
    metadata: Float64Array.from(fixture.metadata),
    texels: fixture.texels,
    numFrames: fixture.numFrames,
    numBands: fixture.numBands,
    numChannels: 2,
    sampleRate: fixture.sampleRate,
    packedTextureSize: packedTextureSizeOf(fixture.texels),
    minFreq: fixture.minFreq,
    bandsPerOctave: fixture.bandsPerOctave,
    synthesisMetadata: {
      bandOffsets: Uint32Array.from(fixture.bandOffsets),
      bandStepLog2s: Int32Array.from(fixture.bandStepLog2s),
      bandLengths: Uint32Array.from(fixture.bandLengths),
    },
  };
}

/** A four-beat, two-octave transform brush with `step` on its one step, as the parity file's state. */
export function transformBrush(algorithm: number, step: Record<string, unknown>): State {
  return createStateForEffects(["transform"], {
    brushSizeTime: 4,
    brushSizePitch: 24,
    stepOverrides: { ...step, algorithm, accumulate: false, sourcePositionMode: "follow" },
    overrides: {
      activeFileId: "parity",
      filepathsBpm: { [PARITY_FILE_PATH]: 120 },
      filepathsOnsetSensitivity: {},
      filesSelection: {},
      filesZoomY: {},
      filesOffsetY: {},
      filesZoom: {},
      filesOffset: {},
    },
  });
}
