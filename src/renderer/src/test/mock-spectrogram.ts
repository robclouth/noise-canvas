import { Vector2 } from "three";
import { SpectrogramData } from "../store/types";

/**
 * Options for creating mock spectrogram data
 */
export interface MockSpectrogramOptions {
  /** Number of time frames (default: 256) */
  numFrames?: number;
  /** Number of frequency bands (default: 128) */
  numBands?: number;
  /** Sample rate in Hz (default: 44100) */
  sampleRate?: number;
  /** Number of audio channels (default: 2) */
  numChannels?: number;
  /** Minimum frequency in Hz (default: 20) */
  minFreq?: number;
  /** Bands per octave (default: 24) */
  bandsPerOctave?: number;
  /** Fill pattern for the data */
  pattern?: "silence" | "sine" | "noise" | "gradient" | "constant" | "bandGradient";
  /** Constant magnitude value (for pattern: "constant") */
  constantMagnitude?: number;
  /**
   * Fractional-band offset applied to every stored metadata frequency. Simulates
   * gaborator's snap-to-band tuning where the actual lowest-band center freq
   * differs from the requested minFreq by up to one band. With drift = d, band i
   * stores freq = minFreq · 2^((numBands-1-i+d)/bandsPerOctave), so d < 0 means
   * the lowest band sits below the configured minFreq (the realistic direction).
   * Defaults to 0 (no drift — metadata aligns exactly with the config).
   */
  metadataFreqDriftBands?: number;
}

/**
 * Creates mock SpectrogramData for testing.
 * The data structure matches what the real gaborator analysis produces.
 */
export function createMockSpectrogramData(options: MockSpectrogramOptions = {}): SpectrogramData {
  const {
    numFrames = 256,
    numBands = 128,
    sampleRate = 44100,
    numChannels = 2,
    minFreq = 20,
    bandsPerOctave = 24,
    pattern = "silence",
    constantMagnitude = 0.5,
    metadataFreqDriftBands = 0,
  } = options;

  // Calculate texture dimensions
  // For simplicity, we'll use a square-ish texture
  const totalPixels = numFrames * numBands;
  const textureWidth = Math.ceil(Math.sqrt(totalPixels));
  const textureHeight = Math.ceil(totalPixels / textureWidth);

  // Create packed data (RGBA: magnitude L, phase L, magnitude R, phase R)
  const packedData = new Float32Array(textureWidth * textureHeight * 4);

  // Fill based on pattern
  for (let band = 0; band < numBands; band++) {
    for (let frame = 0; frame < numFrames; frame++) {
      const pixelIndex = band * numFrames + frame;
      if (pixelIndex >= textureWidth * textureHeight) break;

      const baseIndex = pixelIndex * 4;
      let magnitude = 0;
      let phase = 0;

      switch (pattern) {
        case "silence":
          magnitude = 0;
          phase = 0;
          break;
        case "sine":
          // Create a sine wave pattern based on position
          magnitude = Math.abs(Math.sin((frame / numFrames) * Math.PI * 4));
          phase = (frame / numFrames) * Math.PI * 2;
          break;
        case "noise":
          magnitude = Math.random();
          phase = Math.random() * Math.PI * 2;
          break;
        case "gradient":
          // Gradient from low to high across time
          magnitude = frame / numFrames;
          phase = (band / numBands) * Math.PI * 2;
          break;
        case "constant":
          magnitude = constantMagnitude;
          phase = 0;
          break;
        case "bandGradient":
          // Distinct magnitude per band, constant across time. Lets a test
          // detect whether cross-file paints map each dest band to the source
          // band at the same frequency (not the same fractional UV.y).
          magnitude = (band + 1) / numBands;
          phase = 0;
          break;
      }

      // Left channel
      packedData[baseIndex] = magnitude;
      packedData[baseIndex + 1] = phase;
      // Right channel (same as left for simplicity)
      packedData[baseIndex + 2] = magnitude;
      packedData[baseIndex + 3] = phase;
    }
  }

  // Create inverse map (maps packed texture UV to unpacked spectrogram coordinates)
  const inverseMap = new Float32Array(textureWidth * textureHeight * 2);
  for (let y = 0; y < textureHeight; y++) {
    for (let x = 0; x < textureWidth; x++) {
      const pixelIndex = y * textureWidth + x;
      const linearIndex = pixelIndex;
      const band = Math.floor(linearIndex / numFrames);
      const frame = linearIndex % numFrames;

      const baseIndex = pixelIndex * 2;
      inverseMap[baseIndex] = frame; // x coordinate (time)
      inverseMap[baseIndex + 1] = band; // y coordinate (frequency)
    }
  }

  // Create metadata (per-band info: start offset, length, time scale exponent, frequency)
  const metadata = new Float32Array(numBands * 4);
  for (let band = 0; band < numBands; band++) {
    const baseIndex = band * 4;
    // Simple linear layout: each band has numFrames samples
    metadata[baseIndex] = band * numFrames; // band start offset
    metadata[baseIndex + 1] = numFrames; // band length
    metadata[baseIndex + 2] = 0; // time scale exponent (2^0 = 1, no scaling)
    // Gaborator convention: band 0 is the HIGHEST freq, band (numBands-1)
    // sits near minFreq. Real analysis stores frequencies in that order, so the
    // mock mirrors it here — otherwise cross-file freq-preserving maps in the
    // shader (which assume the Gaborator layout) flip under test.
    // The drift term offsets every stored freq by a fractional band so tests
    // can simulate gaborator's tuning snap.
    const freq = minFreq * Math.pow(2, (numBands - 1 - band + metadataFreqDriftBands) / bandsPerOctave);
    metadata[baseIndex + 3] = freq;
  }

  // Create synthesis metadata
  const bandOffsets = new Uint32Array(numBands);
  const bandStepLog2s = new Int32Array(numBands);
  const bandLengths = new Uint32Array(numBands);

  for (let band = 0; band < numBands; band++) {
    bandOffsets[band] = band * numFrames;
    bandStepLog2s[band] = 0; // No time scaling
    bandLengths[band] = numFrames;
  }

  return {
    packedData,
    inverseMap,
    metadata,
    textureWidth,
    textureHeight,
    numFrames,
    numBands,
    numChannels,
    sampleRate,
    packedTextureSize: new Vector2(textureWidth, textureHeight),
    minFreq,
    bandsPerOctave,
    synthesisMetadata: {
      bandOffsets,
      bandStepLog2s,
      bandLengths,
    },
  };
}

/**
 * Creates a mock spectrogram with a specific test pattern.
 * Useful for testing that strokes are applied to the correct region.
 */
export function createMockSpectrogramWithMarkers(options: MockSpectrogramOptions = {}): SpectrogramData {
  const spectrogramData = createMockSpectrogramData({ ...options, pattern: "silence" });

  // Add markers at specific positions for testing
  // Marker at center (0.5, 0.5)
  const centerFrame = Math.floor(spectrogramData.numFrames / 2);
  const centerBand = Math.floor(spectrogramData.numBands / 2);
  const centerPixel = centerBand * spectrogramData.numFrames + centerFrame;

  if (centerPixel < spectrogramData.textureWidth * spectrogramData.textureHeight) {
    const baseIndex = centerPixel * 4;
    spectrogramData.packedData[baseIndex] = 1.0; // Mark with max magnitude
    spectrogramData.packedData[baseIndex + 2] = 1.0;
  }

  return spectrogramData;
}

/**
 * Calculates the total duration of a spectrogram in seconds.
 */
export function getSpectrogramDuration(spectrogramData: SpectrogramData): number {
  return spectrogramData.numFrames / spectrogramData.sampleRate;
}

/**
 * Reads a pixel value from the packed spectrogram data.
 * Returns [magL, phaseL, magR, phaseR] or null if out of bounds.
 */
export function readSpectrogramPixel(
  data: Float32Array,
  frame: number,
  band: number,
  numFrames: number,
  numBands: number,
  textureWidth: number,
  textureHeight: number,
): [number, number, number, number] | null {
  if (frame < 0 || frame >= numFrames || band < 0 || band >= numBands) {
    return null;
  }

  const pixelIndex = band * numFrames + frame;
  if (pixelIndex >= textureWidth * textureHeight) {
    return null;
  }

  const baseIndex = pixelIndex * 4;
  return [
    data[baseIndex], // magnitude L
    data[baseIndex + 1], // phase L
    data[baseIndex + 2], // magnitude R
    data[baseIndex + 3], // phase R
  ];
}

/**
 * Compares two Float32Arrays for approximate equality.
 * Returns true if all values are within the tolerance.
 */
export function compareSpectrogramData(a: Float32Array, b: Float32Array, tolerance = 1e-5): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > tolerance) {
      return false;
    }
  }

  return true;
}

/**
 * Finds pixels that differ between two spectrograms.
 * Returns an array of { index, valueA, valueB } for differing pixels.
 */
export function findDifferingPixels(
  a: Float32Array,
  b: Float32Array,
  tolerance = 1e-5,
): Array<{ index: number; valueA: number; valueB: number }> {
  const differences: Array<{ index: number; valueA: number; valueB: number }> = [];

  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (Math.abs(a[i] - b[i]) > tolerance) {
      differences.push({ index: i, valueA: a[i], valueB: b[i] });
    }
  }

  return differences;
}

/**
 * Converts UV coordinates (0-1) to frame and band indices.
 */
export function uvToFrameBand(uv: Vector2, numFrames: number, numBands: number): { frame: number; band: number } {
  const frame = Math.floor(uv.x * numFrames);
  const band = Math.floor(uv.y * numBands);
  return {
    frame: Math.max(0, Math.min(numFrames - 1, frame)),
    band: Math.max(0, Math.min(numBands - 1, band)),
  };
}

/**
 * Reads pixel values at UV coordinates from spectrogram data.
 * Returns [magL, phaseL, magR, phaseR] or null if out of bounds.
 */
export function getPixelAtUv(
  data: Float32Array,
  uv: Vector2,
  spectrogramData: SpectrogramData,
): [number, number, number, number] | null {
  const { frame, band } = uvToFrameBand(uv, spectrogramData.numFrames, spectrogramData.numBands);
  return readSpectrogramPixel(
    data,
    frame,
    band,
    spectrogramData.numFrames,
    spectrogramData.numBands,
    spectrogramData.textureWidth,
    spectrogramData.textureHeight,
  );
}

/**
 * Samples multiple pixels within a brush region and returns their values.
 */
export function sampleBrushRegion(
  data: Float32Array,
  brushBottomLeftUv: Vector2,
  brushSizeUv: Vector2,
  spectrogramData: SpectrogramData,
  sampleCount: number = 9,
): Array<{ uv: Vector2; values: [number, number, number, number] | null }> {
  const samples: Array<{ uv: Vector2; values: [number, number, number, number] | null }> = [];
  const gridSize = Math.ceil(Math.sqrt(sampleCount));

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (samples.length >= sampleCount) break;

      const uvX = brushBottomLeftUv.x + (x / (gridSize - 1 || 1)) * brushSizeUv.x;
      const uvY = brushBottomLeftUv.y + (y / (gridSize - 1 || 1)) * brushSizeUv.y;
      const uv = new Vector2(uvX, uvY);
      const values = getPixelAtUv(data, uv, spectrogramData);
      samples.push({ uv, values });
    }
  }

  return samples;
}

/**
 * Calculates expected gradient magnitude at a given UV x-coordinate.
 * For the "gradient" pattern, magnitude varies from 0 to 1 across time.
 */
export function expectedGradientMagnitude(uvX: number): number {
  return uvX;
}

/**
 * Verifies that all magnitude values in the data array are approximately equal to expected.
 * Returns { allMatch, differences } where differences contains mismatched values.
 */
export function verifyMagnitudes(
  data: Float32Array,
  expectedMagnitude: number,
  tolerance = 0.01,
): { allMatch: boolean; differences: Array<{ index: number; actual: number; expected: number }> } {
  const differences: Array<{ index: number; actual: number; expected: number }> = [];

  for (let i = 0; i < data.length; i += 4) {
    const magL = data[i];
    const magR = data[i + 2];

    if (Math.abs(magL - expectedMagnitude) > tolerance) {
      differences.push({ index: i, actual: magL, expected: expectedMagnitude });
    }
    if (Math.abs(magR - expectedMagnitude) > tolerance) {
      differences.push({ index: i + 2, actual: magR, expected: expectedMagnitude });
    }
  }

  return { allMatch: differences.length === 0, differences };
}

/**
 * Verifies that phase values remain unchanged between before and after data.
 * Returns true if all phase values (indices 1 and 3 in each pixel) match.
 */
export function verifyPhasesUnchanged(
  before: Float32Array,
  after: Float32Array,
  tolerance = 1e-5,
): { allMatch: boolean; differences: Array<{ index: number; before: number; after: number }> } {
  const differences: Array<{ index: number; before: number; after: number }> = [];

  const length = Math.min(before.length, after.length);
  for (let i = 0; i < length; i += 4) {
    // Check left phase (index 1)
    if (Math.abs(before[i + 1] - after[i + 1]) > tolerance) {
      differences.push({ index: i + 1, before: before[i + 1], after: after[i + 1] });
    }
    // Check right phase (index 3)
    if (Math.abs(before[i + 3] - after[i + 3]) > tolerance) {
      differences.push({ index: i + 3, before: before[i + 3], after: after[i + 3] });
    }
  }

  return { allMatch: differences.length === 0, differences };
}

/**
 * Calculates average magnitude across all pixels in the data.
 */
export function calculateAverageMagnitude(data: Float32Array): { left: number; right: number; combined: number } {
  let totalLeft = 0;
  let totalRight = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += 4) {
    totalLeft += data[i];
    totalRight += data[i + 2];
    count++;
  }

  const left = totalLeft / count;
  const right = totalRight / count;
  return {
    left,
    right,
    combined: (left + right) / 2,
  };
}
