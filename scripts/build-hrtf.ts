/**
 * HRTF Build Script
 *
 * Downloads MIT KEMAR HRTF data in SOFA format and processes it into a 2D texture
 * for the binaural effect.
 *
 * Output: resources/hrtf/hrtf-data.bin and resources/hrtf/hrtf-metadata.json
 *
 * Usage: npx tsx scripts/build-hrtf.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

// Use jsfive for SOFA (HDF5) file parsing
// @ts-ignore - jsfive doesn't have type definitions
import { File as HDF5File } from "jsfive";

// ============================================================================
// Logging
// ============================================================================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const CURRENT_LOG_LEVEL: LogLevel = "info";

function log(level: LogLevel, message: string, data?: unknown): void {
  if (LOG_LEVELS[level] >= LOG_LEVELS[CURRENT_LOG_LEVEL]) {
    const timestamp = new Date().toISOString().slice(11, 23);
    const prefix = `[${timestamp}] [${level.toUpperCase().padEnd(5)}]`;
    if (data !== undefined) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }
}

function logDebug(message: string, data?: unknown): void {
  log("debug", message, data);
}
function logInfo(message: string, data?: unknown): void {
  log("info", message, data);
}
function logWarn(message: string, data?: unknown): void {
  log("warn", message, data);
}
function logError(message: string, data?: unknown): void {
  log("error", message, data);
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // MIT KEMAR HRTF dataset - widely used reference dataset
  sofaUrl: "https://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa",
  sofaFilename: "mit_kemar_normal_pinna.sofa",

  // FFT size (zero-pad HRIR to this)
  fftSize: 512,

  // Output texture dimensions
  outputAzimuthSteps: 360, // 1 degree resolution
  outputMinFreq: 20,
  outputMaxFreq: 20000,
  outputBandsPerOctave: 36,

  // Paths
  cacheDir: path.join(__dirname, "..", "resources", "hrtf", "cache"),
  outputDir: path.join(__dirname, "..", "resources", "hrtf"),
};

// Calculate number of frequency bands
const totalOctaves = Math.log2(CONFIG.outputMaxFreq / CONFIG.outputMinFreq);
const numFrequencyBands = Math.ceil(totalOctaves * CONFIG.outputBandsPerOctave);

// ============================================================================
// FFT Implementation (Cooley-Tukey radix-2)
// ============================================================================

function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n <= 1) return;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // Cooley-Tukey FFT
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let curWReal = 1;
      let curWImag = 0;

      for (let k = 0; k < halfLen; k++) {
        const evenIdx = i + k;
        const oddIdx = i + k + halfLen;

        const tReal = curWReal * real[oddIdx] - curWImag * imag[oddIdx];
        const tImag = curWReal * imag[oddIdx] + curWImag * real[oddIdx];

        real[oddIdx] = real[evenIdx] - tReal;
        imag[oddIdx] = imag[evenIdx] - tImag;
        real[evenIdx] = real[evenIdx] + tReal;
        imag[evenIdx] = imag[evenIdx] + tImag;

        const newWReal = curWReal * wReal - curWImag * wImag;
        curWImag = curWReal * wImag + curWImag * wReal;
        curWReal = newWReal;
      }
    }
  }
}

function computeFFT(samples: number[], sampleRate: number): { magnitude: number[]; phase: number[] } {
  const n = CONFIG.fftSize;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);

  // Copy samples and zero-pad
  for (let i = 0; i < Math.min(samples.length, n); i++) {
    real[i] = samples[i];
  }

  fft(real, imag);

  // Extract magnitude and phase for positive frequencies
  const numBins = n / 2 + 1;
  const magnitude: number[] = [];
  const phase: number[] = [];

  for (let i = 0; i < numBins; i++) {
    const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    const ph = Math.atan2(imag[i], real[i]);
    magnitude.push(mag);
    phase.push(ph);
  }

  logDebug(`FFT computed: ${samples.length} samples -> ${numBins} bins (sample rate: ${sampleRate}Hz)`);

  return { magnitude, phase };
}

// ============================================================================
// Download Utilities
// ============================================================================

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    logInfo(`Downloading: ${url}`);
    logDebug(`Destination: ${destPath}`);

    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith("https") ? https : http;

    const startTime = Date.now();
    let downloadedBytes = 0;

    protocol
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            logInfo(`Following redirect to: ${redirectUrl}`);
            file.close();
            fs.unlinkSync(destPath);
            downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          logError(`HTTP error: ${response.statusCode}`);
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers["content-length"] || "0", 10);
        logInfo(`File size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

        response.on("data", (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const percent = ((downloadedBytes / totalBytes) * 100).toFixed(1);
            process.stdout.write(`\r[INFO ] Downloading... ${percent}%`);
          }
        });

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(); // New line after progress
          logInfo(`Download complete in ${elapsed}s`);
          resolve();
        });
      })
      .on("error", (err) => {
        logError(`Download failed: ${err.message}`);
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

// ============================================================================
// SOFA File Parsing
// ============================================================================

interface SofaData {
  sampleRate: number;
  sourcePositions: Array<{ azimuth: number; elevation: number; distance: number }>;
  hrirLeft: number[][]; // [measurement][samples]
  hrirRight: number[][];
}

async function loadSofaFile(filePath: string): Promise<SofaData> {
  logInfo(`Loading SOFA file: ${filePath}`);

  const buffer = fs.readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  logDebug(`File size: ${(buffer.length / 1024).toFixed(1)} KB`);

  // Parse HDF5/SOFA file
  const hdf5 = new HDF5File(arrayBuffer);

  // Log available datasets
  logDebug("Available HDF5 keys:", Object.keys(hdf5.keys));

  // Get sample rate
  const sampleRateData = hdf5.get("Data.SamplingRate") as { value: Float64Array };
  const sampleRate = sampleRateData.value[0];
  logInfo(`Sample rate: ${sampleRate} Hz`);

  // Get source positions (azimuth, elevation, distance in spherical coordinates)
  const sourcePositionData = hdf5.get("SourcePosition") as { value: Float64Array; shape: number[] };
  const positionValues = sourcePositionData.value;
  const numMeasurements = sourcePositionData.shape[0];
  logInfo(`Number of measurements: ${numMeasurements}`);

  const sourcePositions: SofaData["sourcePositions"] = [];
  for (let i = 0; i < numMeasurements; i++) {
    sourcePositions.push({
      azimuth: positionValues[i * 3 + 0],
      elevation: positionValues[i * 3 + 1],
      distance: positionValues[i * 3 + 2],
    });
  }

  // Log azimuth range
  const azimuths = sourcePositions.map((p) => p.azimuth);
  const elevations = sourcePositions.map((p) => p.elevation);
  logInfo(`Azimuth range: ${Math.min(...azimuths).toFixed(1)}° to ${Math.max(...azimuths).toFixed(1)}°`);
  logInfo(`Elevation range: ${Math.min(...elevations).toFixed(1)}° to ${Math.max(...elevations).toFixed(1)}°`);

  // Get HRIR data
  // SOFA format: Data.IR has shape [M, R, N] where M=measurements, R=receivers (2 for stereo), N=samples
  const hrirData = hdf5.get("Data.IR") as { value: Float64Array; shape: number[] };
  const hrirValues = hrirData.value;
  const [M, R, N] = hrirData.shape;
  logInfo(`HRIR shape: ${M} measurements × ${R} receivers × ${N} samples`);

  const hrirLeft: number[][] = [];
  const hrirRight: number[][] = [];

  for (let m = 0; m < M; m++) {
    const leftSamples: number[] = [];
    const rightSamples: number[] = [];

    for (let n = 0; n < N; n++) {
      // Data layout: [m, r, n] -> index = m * R * N + r * N + n
      leftSamples.push(hrirValues[m * R * N + 0 * N + n]);
      rightSamples.push(hrirValues[m * R * N + 1 * N + n]);
    }

    hrirLeft.push(leftSamples);
    hrirRight.push(rightSamples);
  }

  logInfo("SOFA data loaded successfully");

  return {
    sampleRate,
    sourcePositions,
    hrirLeft,
    hrirRight,
  };
}

// ============================================================================
// HRTF Processing
// ============================================================================

interface HrtfData {
  // For each measurement: { magnitude: number[], phase: number[] } for left and right
  hrirFFT: Array<{
    left: { magnitude: number[]; phase: number[] };
    right: { magnitude: number[]; phase: number[] };
    azimuth: number;
    elevation: number;
  }>;
  sampleRate: number;
}

function processHrtfData(sofaData: SofaData): HrtfData {
  logInfo("Processing HRTF data...");

  // Filter to only use measurements at elevation 0 (ear level)
  const toleranceDegrees = 5;
  const filteredIndices: number[] = [];

  for (let i = 0; i < sofaData.sourcePositions.length; i++) {
    if (Math.abs(sofaData.sourcePositions[i].elevation) <= toleranceDegrees) {
      filteredIndices.push(i);
    }
  }

  logInfo(`Filtered to ${filteredIndices.length} measurements at elevation ≈ 0°`);

  if (filteredIndices.length === 0) {
    logWarn("No measurements at elevation 0, using all measurements");
    for (let i = 0; i < sofaData.sourcePositions.length; i++) {
      filteredIndices.push(i);
    }
  }

  const hrirFFT: HrtfData["hrirFFT"] = [];

  for (let i = 0; i < filteredIndices.length; i++) {
    const idx = filteredIndices[i];
    const pos = sofaData.sourcePositions[idx];

    const leftFFT = computeFFT(sofaData.hrirLeft[idx], sofaData.sampleRate);
    const rightFFT = computeFFT(sofaData.hrirRight[idx], sofaData.sampleRate);

    hrirFFT.push({
      left: leftFFT,
      right: rightFFT,
      azimuth: pos.azimuth,
      elevation: pos.elevation,
    });

    if (i % 10 === 0) {
      logDebug(`Processed ${i + 1}/${filteredIndices.length} measurements`);
    }
  }

  // Sort by azimuth for easier interpolation
  hrirFFT.sort((a, b) => a.azimuth - b.azimuth);

  logInfo(`HRTF processing complete: ${hrirFFT.length} azimuth positions`);
  logDebug(
    `Azimuth range: ${hrirFFT[0].azimuth.toFixed(1)}° to ${hrirFFT[hrirFFT.length - 1].azimuth.toFixed(1)}°`,
  );

  return {
    hrirFFT,
    sampleRate: sofaData.sampleRate,
  };
}

function interpolateHrtf(
  hrtfData: HrtfData,
  targetAzimuth: number,
): { magnitude: [number[], number[]]; phase: [number[], number[]] } {
  // SOFA data uses 0-360 range, so convert targetAzimuth to match
  // First normalize to [-180, 180], then convert to [0, 360]
  while (targetAzimuth > 180) targetAzimuth -= 360;
  while (targetAzimuth < -180) targetAzimuth += 360;

  // Convert to 0-360 range to match SOFA convention
  if (targetAzimuth < 0) {
    targetAzimuth += 360;
  }

  const measurements = hrtfData.hrirFFT;

  // Find bracketing measurements
  let lowerIdx = 0;
  let upperIdx = 0;

  for (let i = 0; i < measurements.length - 1; i++) {
    if (targetAzimuth >= measurements[i].azimuth && targetAzimuth <= measurements[i + 1].azimuth) {
      lowerIdx = i;
      upperIdx = i + 1;
      break;
    }
  }

  // Handle edge cases (wrap around)
  if (targetAzimuth < measurements[0].azimuth) {
    // Before first measurement - extrapolate from last to first (wrapping)
    lowerIdx = measurements.length - 1;
    upperIdx = 0;
  } else if (targetAzimuth > measurements[measurements.length - 1].azimuth) {
    // After last measurement - extrapolate from last to first (wrapping)
    lowerIdx = measurements.length - 1;
    upperIdx = 0;
  }

  // Calculate interpolation factor
  let t = 0;
  if (lowerIdx !== upperIdx) {
    const azLower = measurements[lowerIdx].azimuth;
    let azUpper = measurements[upperIdx].azimuth;
    let adjustedTarget = targetAzimuth;

    // Handle wraparound (e.g., interpolating between 355° and 0°)
    if (azUpper < azLower) {
      azUpper += 360;
      if (targetAzimuth < azLower) {
        adjustedTarget += 360;
      }
    }

    t = (adjustedTarget - azLower) / (azUpper - azLower);
    t = Math.max(0, Math.min(1, t));
  }

  const numBins = measurements[0].left.magnitude.length;
  const leftMag: number[] = [];
  const leftPhase: number[] = [];
  const rightMag: number[] = [];
  const rightPhase: number[] = [];

  for (let bin = 0; bin < numBins; bin++) {
    // Linear interpolation for magnitude
    const lMagLower = measurements[lowerIdx].left.magnitude[bin];
    const lMagUpper = measurements[upperIdx].left.magnitude[bin];
    const rMagLower = measurements[lowerIdx].right.magnitude[bin];
    const rMagUpper = measurements[upperIdx].right.magnitude[bin];

    leftMag.push(lMagLower + t * (lMagUpper - lMagLower));
    rightMag.push(rMagLower + t * (rMagUpper - rMagLower));

    // Phase interpolation with unwrapping
    const lPhaseLower = measurements[lowerIdx].left.phase[bin];
    let lPhaseUpper = measurements[upperIdx].left.phase[bin];
    const rPhaseLower = measurements[lowerIdx].right.phase[bin];
    let rPhaseUpper = measurements[upperIdx].right.phase[bin];

    while (lPhaseUpper - lPhaseLower > Math.PI) lPhaseUpper -= 2 * Math.PI;
    while (lPhaseUpper - lPhaseLower < -Math.PI) lPhaseUpper += 2 * Math.PI;
    while (rPhaseUpper - rPhaseLower > Math.PI) rPhaseUpper -= 2 * Math.PI;
    while (rPhaseUpper - rPhaseLower < -Math.PI) rPhaseUpper += 2 * Math.PI;

    leftPhase.push(lPhaseLower + t * (lPhaseUpper - lPhaseLower));
    rightPhase.push(rPhaseLower + t * (rPhaseUpper - rPhaseLower));
  }

  return {
    magnitude: [leftMag, rightMag],
    phase: [leftPhase, rightPhase],
  };
}

function resampleToLogFrequency(
  linearMag: number[],
  linearPhase: number[],
  sampleRate: number,
): { mag: number[]; phase: number[] } {
  const freqPerBin = sampleRate / CONFIG.fftSize;
  const numLinearBins = linearMag.length;

  const mag: number[] = [];
  const phase: number[] = [];

  for (let band = 0; band < numFrequencyBands; band++) {
    // Calculate center frequency of this log-scale band
    const bandNorm = band / numFrequencyBands;
    const bandFreq = CONFIG.outputMinFreq * Math.pow(CONFIG.outputMaxFreq / CONFIG.outputMinFreq, bandNorm);

    // Find corresponding linear FFT bin
    const linearBin = bandFreq / freqPerBin;

    // Interpolate
    const lowerBin = Math.floor(linearBin);
    const upperBin = Math.min(lowerBin + 1, numLinearBins - 1);
    const t = linearBin - lowerBin;

    if (lowerBin >= 0 && lowerBin < numLinearBins) {
      mag.push(linearMag[lowerBin] + t * (linearMag[upperBin] - linearMag[lowerBin]));

      // Interpolate phase with unwrapping
      const phaseLower = linearPhase[lowerBin];
      let phaseUpper = linearPhase[upperBin];
      while (phaseUpper - phaseLower > Math.PI) phaseUpper -= 2 * Math.PI;
      while (phaseUpper - phaseLower < -Math.PI) phaseUpper += 2 * Math.PI;
      phase.push(phaseLower + t * (phaseUpper - phaseLower));
    } else {
      mag.push(1);
      phase.push(0);
    }
  }

  return { mag, phase };
}

// ============================================================================
// Diffuse Field Equalization
// ============================================================================

/**
 * Compute diffuse field equalization compensation curve.
 *
 * The "diffuse field" response is the power-average of HRTF magnitudes across
 * all directions. This contains direction-independent coloration from:
 * - Measurement equipment (microphones, speakers)
 * - Ear canal resonance
 * - Pinna resonance
 *
 * By dividing each HRTF by this average, we remove the coloration while
 * preserving the direction-dependent spatial cues (ILD, ITD).
 *
 * @returns Compensation curve (1/average) for each frequency bin
 */
function computeDiffuseFieldCompensation(hrtfData: HrtfData): number[] {
  logInfo("Computing diffuse field equalization...");

  const numBins = hrtfData.hrirFFT[0].left.magnitude.length;
  const numMeasurements = hrtfData.hrirFFT.length;

  // Compute power average (RMS) across all directions and both ears
  const powerSum = new Float64Array(numBins);

  for (const measurement of hrtfData.hrirFFT) {
    for (let bin = 0; bin < numBins; bin++) {
      // Sum squared magnitudes (power) for both ears
      powerSum[bin] += measurement.left.magnitude[bin] ** 2;
      powerSum[bin] += measurement.right.magnitude[bin] ** 2;
    }
  }

  // Average and take square root to get RMS
  const compensation: number[] = [];
  const totalSamples = numMeasurements * 2; // Both ears

  for (let bin = 0; bin < numBins; bin++) {
    const rms = Math.sqrt(powerSum[bin] / totalSamples);

    // Compensation is inverse of average, with floor to avoid division by zero
    // and ceiling to prevent extreme boosts at very low magnitudes
    const minRms = 0.001; // -60 dB floor
    const maxBoost = 10; // +20 dB max boost
    const safeRms = Math.max(rms, minRms);
    compensation.push(Math.min(1 / safeRms, maxBoost));
  }

  // Log some stats
  const avgCompensation = compensation.reduce((a, b) => a + b, 0) / compensation.length;
  const maxComp = Math.max(...compensation);
  const minComp = Math.min(...compensation);

  logInfo(`Diffuse field compensation computed:`);
  logInfo(`  Average: ${avgCompensation.toFixed(3)}x`);
  logInfo(`  Range: ${minComp.toFixed(3)}x to ${maxComp.toFixed(3)}x`);
  logInfo(`  (${(20 * Math.log10(minComp)).toFixed(1)} dB to ${(20 * Math.log10(maxComp)).toFixed(1)} dB)`);

  return compensation;
}

/**
 * Resample diffuse field compensation from linear FFT bins to log-frequency bands.
 */
function resampleCompensationToLogFrequency(
  linearCompensation: number[],
  sampleRate: number,
): number[] {
  const freqPerBin = sampleRate / CONFIG.fftSize;
  const numLinearBins = linearCompensation.length;

  const logCompensation: number[] = [];

  for (let band = 0; band < numFrequencyBands; band++) {
    // Calculate center frequency of this log-scale band
    const bandNorm = band / numFrequencyBands;
    const bandFreq = CONFIG.outputMinFreq * Math.pow(CONFIG.outputMaxFreq / CONFIG.outputMinFreq, bandNorm);

    // Find corresponding linear FFT bin
    const linearBin = bandFreq / freqPerBin;

    // Interpolate
    const lowerBin = Math.floor(linearBin);
    const upperBin = Math.min(lowerBin + 1, numLinearBins - 1);
    const t = linearBin - lowerBin;

    if (lowerBin >= 0 && lowerBin < numLinearBins) {
      logCompensation.push(
        linearCompensation[lowerBin] + t * (linearCompensation[upperBin] - linearCompensation[lowerBin]),
      );
    } else {
      logCompensation.push(1); // No compensation outside range
    }
  }

  return logCompensation;
}

// ============================================================================
// Main Build Process
// ============================================================================

async function main() {
  console.log("");
  logInfo("═══════════════════════════════════════════════════════════════");
  logInfo("HRTF Build Script");
  logInfo("═══════════════════════════════════════════════════════════════");
  console.log("");

  logInfo(`Output azimuths: ${CONFIG.outputAzimuthSteps} (1° resolution)`);
  logInfo(`Output frequency bands: ${numFrequencyBands} (${CONFIG.outputBandsPerOctave} bands/octave)`);
  logInfo(`Frequency range: ${CONFIG.outputMinFreq}Hz - ${CONFIG.outputMaxFreq}Hz`);
  console.log("");

  // Ensure directories exist
  fs.mkdirSync(CONFIG.cacheDir, { recursive: true });
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  logDebug(`Cache directory: ${CONFIG.cacheDir}`);
  logDebug(`Output directory: ${CONFIG.outputDir}`);

  // Download SOFA file if not cached
  const sofaPath = path.join(CONFIG.cacheDir, CONFIG.sofaFilename);

  if (!fs.existsSync(sofaPath)) {
    logInfo("SOFA file not found in cache, downloading...");
    await downloadFile(CONFIG.sofaUrl, sofaPath);
  } else {
    const stats = fs.statSync(sofaPath);
    logInfo(`Using cached SOFA file (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  // Load and parse SOFA file
  console.log("");
  const sofaData = await loadSofaFile(sofaPath);

  // Process HRTF data
  console.log("");
  const hrtfData = processHrtfData(sofaData);

  // Compute diffuse field equalization
  console.log("");
  const linearCompensation = computeDiffuseFieldCompensation(hrtfData);
  const logCompensation = resampleCompensationToLogFrequency(linearCompensation, hrtfData.sampleRate);

  // Build 2D texture
  console.log("");
  logInfo(`Building 2D texture: ${CONFIG.outputAzimuthSteps} × ${numFrequencyBands} pixels`);

  // Each pixel: [magL, phaseL, magR, phaseR]
  const textureData = new Float32Array(CONFIG.outputAzimuthSteps * numFrequencyBands * 4);
  let minMag = Infinity,
    maxMag = -Infinity;

  for (let azStep = 0; azStep < CONFIG.outputAzimuthSteps; azStep++) {
    // Map azimuth step to angle (-180 to +180)
    // This is the USER convention: +90° = right ear, -90° = left ear
    const userAzimuth = -180 + (azStep / CONFIG.outputAzimuthSteps) * 360;

    // Convert to SOFA convention (counter-clockwise): +90° = left ear, -90° = right ear
    // SOFA/CIPIC uses: 0° front, 90° left, 180° back, 270° right
    // User expects: 0° front, +90° right, -90° left
    // So we negate: sofaAzimuth = -userAzimuth
    const sofaAzimuth = -userAzimuth;

    // Interpolate HRTF for this azimuth using SOFA convention
    const interpolated = interpolateHrtf(hrtfData, sofaAzimuth);

    // Resample to log frequency scale
    const leftResampled = resampleToLogFrequency(
      interpolated.magnitude[0],
      interpolated.phase[0],
      hrtfData.sampleRate,
    );
    const rightResampled = resampleToLogFrequency(
      interpolated.magnitude[1],
      interpolated.phase[1],
      hrtfData.sampleRate,
    );

    // Write to texture (row-major: each row is one frequency, columns are azimuths)
    for (let freqBand = 0; freqBand < numFrequencyBands; freqBand++) {
      const pixelIdx = freqBand * CONFIG.outputAzimuthSteps + azStep;
      const baseIdx = pixelIdx * 4;

      // Apply diffuse field equalization to magnitude (not phase)
      const compensation = logCompensation[freqBand];
      const eqMagL = leftResampled.mag[freqBand] * compensation;
      const eqMagR = rightResampled.mag[freqBand] * compensation;

      textureData[baseIdx + 0] = eqMagL;
      textureData[baseIdx + 1] = leftResampled.phase[freqBand];
      textureData[baseIdx + 2] = eqMagR;
      textureData[baseIdx + 3] = rightResampled.phase[freqBand];

      minMag = Math.min(minMag, eqMagL, eqMagR);
      maxMag = Math.max(maxMag, eqMagL, eqMagR);
    }

    if (azStep % 36 === 0) {
      logDebug(`Processed azimuth ${userAzimuth.toFixed(0)}° (${azStep + 1}/${CONFIG.outputAzimuthSteps})`);
    }
  }

  logInfo(`Magnitude range: ${minMag.toFixed(4)} to ${maxMag.toFixed(4)}`);

  // Write binary data
  console.log("");
  const binPath = path.join(CONFIG.outputDir, "hrtf-data.bin");
  const binBuffer = Buffer.from(textureData.buffer);
  fs.writeFileSync(binPath, binBuffer);
  logInfo(`Wrote binary data: ${binPath}`);
  logInfo(`Binary size: ${(binBuffer.length / 1024 / 1024).toFixed(2)} MB`);

  // Write metadata
  const metadata = {
    version: 2,
    source: "MIT KEMAR (normal pinna)",
    sourceUrl: CONFIG.sofaUrl,
    sampleRate: hrtfData.sampleRate,
    fftSize: CONFIG.fftSize,
    elevation: 0,
    azimuthMin: -180,
    azimuthMax: 180,
    numAzimuths: CONFIG.outputAzimuthSteps,
    numFrequencyBands: numFrequencyBands,
    minFreq: CONFIG.outputMinFreq,
    maxFreq: CONFIG.outputMaxFreq,
    bandsPerOctave: CONFIG.outputBandsPerOctave,
    textureWidth: CONFIG.outputAzimuthSteps,
    textureHeight: numFrequencyBands,
    magnitudeRange: { min: minMag, max: maxMag },
    diffuseFieldEqualized: true,
  };

  const metaPath = path.join(CONFIG.outputDir, "hrtf-metadata.json");
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
  logInfo(`Wrote metadata: ${metaPath}`);

  console.log("");
  logInfo("═══════════════════════════════════════════════════════════════");
  logInfo("HRTF build complete!");
  logInfo(`Texture dimensions: ${metadata.textureWidth} × ${metadata.textureHeight}`);
  logInfo("═══════════════════════════════════════════════════════════════");
  console.log("");
}

main().catch((err) => {
  logError(`Build failed: ${err.message}`);
  logError(err.stack);
  process.exit(1);
});
