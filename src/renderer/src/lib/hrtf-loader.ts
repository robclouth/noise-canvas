/**
 * HRTF Texture Loader
 *
 * Loads pre-processed HRTF data from resources/hrtf/ and creates a DataTexture.
 * The texture is 2D with X = azimuth, Y = frequency (log-scale).
 * Each pixel contains [magL, phaseL, magR, phaseR] as RGBA32F.
 */

import { useMemo, useState, useEffect } from "react";
import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, RGBAFormat } from "three";

export interface HrtfMetadata {
  version: number;
  subject: string;
  sampleRate: number;
  fftSize: number;
  elevation: number;
  azimuthMin: number;
  azimuthMax: number;
  numAzimuths: number;
  numFrequencyBands: number;
  minFreq: number;
  maxFreq: number;
  bandsPerOctave: number;
  textureWidth: number;
  textureHeight: number;
}

// Cached HRTF data
let cachedHrtfTexture: DataTexture | null = null;
let cachedHrtfMetadata: HrtfMetadata | null = null;
let loadingPromise: Promise<{ texture: DataTexture; metadata: HrtfMetadata }> | null = null;

/**
 * Creates a placeholder HRTF texture for when the real data isn't loaded.
 * This is a 1x1 texture with neutral values (magnitude 1, phase 0).
 */
function createPlaceholderHrtfTexture(): DataTexture {
  const data = new Float32Array(4);
  data[0] = 1.0; // magL
  data[1] = 0.0; // phaseL
  data[2] = 1.0; // magR
  data[3] = 0.0; // phaseR

  const tex = new DataTexture(data, 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * Default metadata for when HRTF data isn't loaded.
 */
const defaultMetadata: HrtfMetadata = {
  version: 0,
  subject: "placeholder",
  sampleRate: 44100,
  fftSize: 512,
  elevation: 0,
  azimuthMin: -180,
  azimuthMax: 180,
  numAzimuths: 1,
  numFrequencyBands: 1,
  minFreq: 20,
  maxFreq: 20000,
  bandsPerOctave: 36,
  textureWidth: 1,
  textureHeight: 1,
};

/**
 * Get the path to HRTF data directory.
 * In development: uses project's resources/hrtf/
 * In production: uses app's resources directory
 */
function getHrtfPath(): string {
  // Check if we're in development by looking for common dev indicators
  const isDev =
    process.env.NODE_ENV === "development" || window.location.protocol === "http:";

  if (isDev) {
    // In development, use the project's resources directory
    // This assumes the dev server is running from the project root
    return window.nodePath.join(process.cwd(), "resources", "hrtf");
  } else {
    // In production, use the app's resources path
    // process.resourcesPath points to the app's Resources folder
    return window.nodePath.join(process.resourcesPath, "hrtf");
  }
}

/**
 * Loads HRTF data from resources/hrtf/.
 * Returns cached data if already loaded.
 */
export async function loadHrtfData(): Promise<{ texture: DataTexture; metadata: HrtfMetadata }> {
  // Return cached if available
  if (cachedHrtfTexture && cachedHrtfMetadata) {
    return { texture: cachedHrtfTexture, metadata: cachedHrtfMetadata };
  }

  // Return existing promise if loading is in progress
  if (loadingPromise) {
    return loadingPromise;
  }

  // Start loading
  loadingPromise = (async () => {
    try {
      const hrtfDir = getHrtfPath();

      // Load metadata
      const metadataPath = window.nodePath.join(hrtfDir, "hrtf-metadata.json");
      const metadataContent = await window.nodeFs.readFile(metadataPath, { encoding: "utf-8" });
      const metadata: HrtfMetadata = JSON.parse(metadataContent);

      // Load binary data
      const dataPath = window.nodePath.join(hrtfDir, "hrtf-data.bin");
      const dataBuffer = await window.nodeFs.readFile(dataPath);
      const data = new Float32Array(
        dataBuffer.buffer,
        dataBuffer.byteOffset,
        dataBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

      // Create DataTexture
      const texture = new DataTexture(
        data,
        metadata.textureWidth,
        metadata.textureHeight,
        RGBAFormat,
        FloatType,
      );

      // Configure for bilinear interpolation
      texture.wrapS = ClampToEdgeWrapping; // Azimuth wraps, but we handle that in shader
      texture.wrapT = ClampToEdgeWrapping; // Frequency doesn't wrap
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;

      // Cache the results
      cachedHrtfTexture = texture;
      cachedHrtfMetadata = metadata;

      console.log(
        `[HRTF] Loaded texture: ${metadata.textureWidth}x${metadata.textureHeight}, ` +
          `azimuth ${metadata.azimuthMin}° to ${metadata.azimuthMax}°, ` +
          `freq ${metadata.minFreq}Hz to ${metadata.maxFreq}Hz`,
      );

      return { texture, metadata };
    } catch (error) {
      console.warn("[HRTF] Failed to load HRTF data, using placeholder:", error);
      const placeholder = createPlaceholderHrtfTexture();
      cachedHrtfTexture = placeholder;
      cachedHrtfMetadata = defaultMetadata;
      return { texture: placeholder, metadata: defaultMetadata };
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

/**
 * React hook for loading and using HRTF texture.
 * Returns { texture, metadata, loading } - texture is a placeholder until loaded.
 */
export function useHrtfTexture() {
  const placeholder = useMemo(() => createPlaceholderHrtfTexture(), []);
  const [texture, setTexture] = useState<DataTexture>(cachedHrtfTexture || placeholder);
  const [metadata, setMetadata] = useState<HrtfMetadata>(cachedHrtfMetadata || defaultMetadata);
  const [loading, setLoading] = useState(!cachedHrtfTexture);

  useEffect(() => {
    if (cachedHrtfTexture && cachedHrtfMetadata) {
      setTexture(cachedHrtfTexture);
      setMetadata(cachedHrtfMetadata);
      setLoading(false);
      return;
    }

    loadHrtfData()
      .then(({ texture: loadedTexture, metadata: loadedMetadata }) => {
        setTexture(loadedTexture);
        setMetadata(loadedMetadata);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  return { texture, metadata, loading };
}

/**
 * Get cached HRTF texture synchronously.
 * Returns placeholder if not yet loaded.
 * Call loadHrtfData() first to ensure data is loaded.
 */
export function getHrtfTexture(): DataTexture {
  return cachedHrtfTexture || createPlaceholderHrtfTexture();
}

/**
 * Get cached HRTF metadata synchronously.
 * Returns default metadata if not yet loaded.
 */
export function getHrtfMetadata(): HrtfMetadata {
  return cachedHrtfMetadata || defaultMetadata;
}
