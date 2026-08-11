import { GLSL3, RawShaderMaterial, Texture, UniformsUtils, Vector2, WebGLRenderer, WebGLRenderTarget } from "three";
import { defaultValues } from "@renderer/effects/base-effect";
import type { SpectrogramData } from "@renderer/store/types";
import exportFrag from "../glsl/export.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { colormapMountColor, getColormapTexture, type ColormapId } from "./image-export-colormaps";
import { computePosterLayout, drawPoster, type PosterInfo } from "./image-export-poster";
import { withPlatformDefines } from "./shader-utils";
import { createByteTarget, renderMaterialToBytes } from "./snapshot-capture";

export type AspectId = "square" | "portrait" | "story" | "landscape" | "wide";

export interface AspectDef {
  id: AspectId;
  label: string;
  /** Compact form for the picker, where five options share one row. */
  short: string;
  /** Width divided by height. */
  ratio: number;
}

export const ASPECTS: readonly AspectDef[] = [
  { id: "square", label: "Square", short: "1:1", ratio: 1 },
  { id: "portrait", label: "Portrait", short: "4:5", ratio: 4 / 5 },
  { id: "story", label: "Story", short: "9:16", ratio: 9 / 16 },
  { id: "landscape", label: "Landscape", short: "3:2", ratio: 3 / 2 },
  { id: "wide", label: "Wide", short: "16:9", ratio: 16 / 9 },
] as const;

export const SIZE_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 2048, label: "2K" },
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
] as const;

export interface ImageExportOptions {
  colormap: ColormapId;
  aspect: AspectId;
  /** Pixels along the image's longer edge. */
  size: number;
  /** Mount the spectrogram on a titled plate with time and pitch labels. */
  poster: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ImageExportOptions = {
  colormap: "magma",
  aspect: "square",
  size: 4096,
  poster: false,
};

export interface ImageExportSource {
  /** The committed spectrogram to draw, as an FBO texture. */
  texture: Texture;
  /** Per-band packing offsets, lengths, and time strides. */
  metadataTexture: Texture;
  spectrogramData: SpectrogramData;
}

export interface DbRange {
  minDb: number;
  maxDb: number;
}

/** The span the probe pass quantises into 256 levels, covering any usable level. */
const PROBE_MIN_DB = -140;
const PROBE_MAX_DB = 20;
const PROBE_LONG_EDGE = 384;

/** Widest and narrowest span the auto range is allowed to settle on. */
const MIN_RANGE_DB = 45;
const MAX_RANGE_DB = 95;

/** Largest tile rendered in one draw call, in pixels per side. */
const TILE_SIZE = 1024;

/** Pixel dimensions for an aspect ratio at a given long-edge size. */
export function computeImageSize(ratio: number, longEdge: number): { width: number; height: number } {
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  return ratio >= 1
    ? { width: even(longEdge), height: even(longEdge / ratio) }
    : { width: even(longEdge * ratio), height: even(longEdge) };
}

/**
 * How many samples each output pixel needs across its time footprint. One tap
 * per stored time bin the pixel covers in the finest band; anything beyond that
 * only costs time. Capped to match the shader's own clamp.
 */
export function computeTimeTaps(numFrames: number, imageWidth: number, bandStepLog2s: Int32Array): number {
  let finestStepLog2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < bandStepLog2s.length; i++) {
    finestStepLog2 = Math.min(finestStepLog2, bandStepLog2s[i]);
  }
  const stride = Number.isFinite(finestStepLog2) ? Math.pow(2, finestStepLog2) : 1;
  const binsPerPixel = numFrames / Math.max(imageWidth, 1) / Math.max(stride, 1);
  return Math.max(1, Math.min(64, Math.ceil(binsPerPixel)));
}

/**
 * Picks the black and white points from the histogram of a probe render.
 *
 * The white point sits just under the peak so a handful of hot pixels cannot
 * dim everything else, and the black point sits low enough that the noise floor
 * reads as background while decay tails survive. The span is then held between
 * MIN_RANGE_DB and MAX_RANGE_DB so neither a near-silent nor a wall-of-noise
 * file ends up with a degenerate range. Pixels that clamp to the very bottom of
 * the probe span are digital silence and are left out of the count.
 */
export function computeAutoRange(probePixels: Uint8Array, fallback: DbRange = { minDb: -90, maxDb: -10 }): DbRange {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < probePixels.length; i += 4) {
    histogram[probePixels[i]]++;
  }
  histogram[0] = 0;

  let total = 0;
  for (let i = 0; i < 256; i++) total += histogram[i];
  if (total === 0) return fallback;

  const levelToDb = (level: number): number => PROBE_MIN_DB + (level / 255) * (PROBE_MAX_DB - PROBE_MIN_DB);
  const percentile = (fraction: number): number => {
    const target = fraction * total;
    let seen = 0;
    for (let i = 0; i < 256; i++) {
      seen += histogram[i];
      if (seen >= target) return levelToDb(i);
    }
    return levelToDb(255);
  };

  const maxDb = percentile(0.9985);
  const black = percentile(0.25);
  const minDb = Math.min(Math.max(black, maxDb - MAX_RANGE_DB), maxDb - MIN_RANGE_DB);
  return { minDb, maxDb };
}

let exportMaterial: RawShaderMaterial | null = null;

function getExportMaterial(): RawShaderMaterial {
  if (exportMaterial) return exportMaterial;
  exportMaterial = new RawShaderMaterial({
    uniforms: {
      ...UniformsUtils.clone(defaultValues),
      minDb: { value: -90 },
      maxDb: { value: -10 },
      colormapMode: { value: 1 },
      colormapTex: { value: null },
      timeTaps: { value: 8 },
      tileUvMin: { value: new Vector2(0, 0) },
      tileUvSize: { value: new Vector2(1, 1) },
      imageSize: { value: new Vector2(1, 1) },
      tileOriginPx: { value: new Vector2(0, 0) },
      probeMode: { value: false },
      probeMinDb: { value: PROBE_MIN_DB },
      probeMaxDb: { value: PROBE_MAX_DB },
      wrapMode: { value: 0 },
    },
    vertexShader: passThroughVert,
    fragmentShader: withPlatformDefines(exportFrag),
    glslVersion: GLSL3,
  });
  return exportMaterial;
}

function applySourceUniforms(material: RawShaderMaterial, source: ImageExportSource, colormap: ColormapId): void {
  const { spectrogramData: data } = source;
  const uniforms = material.uniforms;
  uniforms.sourceSpectrogramTex.value = source.texture;
  uniforms.sourceMetadataTex.value = source.metadataTexture;
  uniforms.sourceFrameCount.value = data.numFrames;
  uniforms.sourceBandCount.value = data.numBands;
  uniforms.sourceChannelCount.value = data.numChannels;
  uniforms.sourceSpectrogramTextureSize.value = data.packedTextureSize;
  uniforms.sourceMinFreq.value = data.minFreq;
  uniforms.sourceBandsPerOctave.value = data.bandsPerOctave;
  uniforms.sourceSampleRate.value = data.sampleRate;
  uniforms.wrapMode.value = 0;
  // The ramp sampler is read on every path, so it stays bound even in editor
  // mode where the branch that uses it is not taken.
  uniforms.colormapMode.value = colormap === "native" ? 0 : 1;
  uniforms.colormapTex.value = getColormapTexture(colormap) ?? getColormapTexture("mono");
}

/** Serialises GPU work so two renders cannot interleave on the shared material. */
let pending: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = pending.then(work, work);
  pending = next.catch(() => undefined);
  return next;
}

async function renderTiles(
  gl: WebGLRenderer,
  material: RawShaderMaterial,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const tilesX = Math.ceil(width / TILE_SIZE);
  const tilesY = Math.ceil(height / TILE_SIZE);
  const totalTiles = tilesX * tilesY;
  let target: WebGLRenderTarget | null = null;
  let done = 0;

  try {
    // Tiles are laid out bottom-up to match GL's pixel origin; the readback is
    // flipped into the canvas's top-down rows as each tile lands.
    for (let ty = 0; ty < tilesY; ty++) {
      const y0 = ty * TILE_SIZE;
      const tileH = Math.min(TILE_SIZE, height - y0);
      for (let tx = 0; tx < tilesX; tx++) {
        const x0 = tx * TILE_SIZE;
        const tileW = Math.min(TILE_SIZE, width - x0);

        if (!target) {
          target = createByteTarget(tileW, tileH);
        } else if (target.width !== tileW || target.height !== tileH) {
          target.setSize(tileW, tileH);
        }

        (material.uniforms.tileUvMin.value as Vector2).set(x0 / width, y0 / height);
        (material.uniforms.tileUvSize.value as Vector2).set(tileW / width, tileH / height);
        (material.uniforms.tileOriginPx.value as Vector2).set(x0, y0);

        const pixels = await renderMaterialToBytes(gl, material, target);

        const image = ctx.createImageData(tileW, tileH);
        const rowBytes = tileW * 4;
        for (let row = 0; row < tileH; row++) {
          const src = (tileH - 1 - row) * rowBytes;
          image.data.set(pixels.subarray(src, src + rowBytes), row * rowBytes);
        }
        ctx.putImageData(image, x0, height - y0 - tileH);

        done++;
        onProgress?.(done / totalTiles);
      }
    }
  } finally {
    target?.dispose();
  }
}

/**
 * Renders the spectrogram to a canvas of exactly `width` × `height`, with no
 * chrome. The whole file spans the image; view zoom and pan are ignored.
 */
export function renderSpectrogramPlot(
  gl: WebGLRenderer,
  source: ImageExportSource,
  width: number,
  height: number,
  colormap: ColormapId,
  onProgress?: (fraction: number) => void,
): Promise<HTMLCanvasElement> {
  return serialize(async () => {
    const material = getExportMaterial();
    applySourceUniforms(material, source, colormap);
    (material.uniforms.imageSize.value as Vector2).set(width, height);
    material.uniforms.timeTaps.value = computeTimeTaps(
      source.spectrogramData.numFrames,
      width,
      source.spectrogramData.synthesisMetadata.bandStepLog2s,
    );

    const range = await measureRange(gl, material, width, height);
    material.uniforms.minDb.value = range.minDb;
    material.uniforms.maxDb.value = range.maxDb;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create a 2D context for the exported image");

    await renderTiles(gl, material, ctx, width, height, onProgress);
    return canvas;
  });
}

/**
 * Runs the probe pass at thumbnail size and derives the black and white points
 * from it. Uses the same footprint averaging as the final render so the levels
 * it measures are the ones that will be drawn.
 */
async function measureRange(
  gl: WebGLRenderer,
  material: RawShaderMaterial,
  width: number,
  height: number,
): Promise<DbRange> {
  const scale = PROBE_LONG_EDGE / Math.max(width, height);
  const probeW = Math.max(2, Math.round(width * scale));
  const probeH = Math.max(2, Math.round(height * scale));

  const target = createByteTarget(probeW, probeH);
  try {
    material.uniforms.probeMode.value = true;
    (material.uniforms.tileUvMin.value as Vector2).set(0, 0);
    (material.uniforms.tileUvSize.value as Vector2).set(1, 1);
    (material.uniforms.tileOriginPx.value as Vector2).set(0, 0);
    const pixels = await renderMaterialToBytes(gl, material, target);
    return computeAutoRange(pixels);
  } finally {
    material.uniforms.probeMode.value = false;
    target.dispose();
  }
}

/**
 * Renders the finished export image at the requested aspect and size, mounting
 * it on a poster plate when asked. `posterInfo` is only read in poster mode.
 */
export async function renderExportImage(
  gl: WebGLRenderer,
  source: ImageExportSource,
  options: ImageExportOptions,
  posterInfo: PosterInfo,
  onProgress?: (fraction: number) => void,
): Promise<HTMLCanvasElement> {
  const ratio = (ASPECTS.find((a) => a.id === options.aspect) ?? ASPECTS[0]).ratio;
  const { width, height } = computeImageSize(ratio, options.size);

  if (!options.poster) {
    return renderSpectrogramPlot(gl, source, width, height, options.colormap, onProgress);
  }

  const layout = computePosterLayout(width, height);
  const plot = await renderSpectrogramPlot(gl, source, layout.plotW, layout.plotH, options.colormap, onProgress);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create a 2D context for the exported image");
  drawPoster(ctx, plot, layout, posterInfo, colormapMountColor(options.colormap));
  return canvas;
}

/** Encodes a canvas as PNG bytes. */
export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not encode the image as PNG");
  return new Uint8Array(await blob.arrayBuffer());
}
