import { GLSL3, RawShaderMaterial, Texture, Vector2, WebGLRenderer, WebGLRenderTarget } from "three";
import { createDefaultUniforms } from "@renderer/effects/base-effect";
import type { SpectrogramData } from "@renderer/store/types";
import exportFrag from "../glsl/export.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { colormapMountColor, getColormapTexture, type ColormapId } from "./image-export-colormaps";
import { computePosterLayout, drawPoster, type PosterInfo } from "./image-export-poster";
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

/** A span of a file's packed state on the GPU, laid out as a source of its own. */
export interface ExportSpan {
  texture: Texture;
  metadataTexture: Texture;
  startFrame: number;
  endFrame: number;
}

/**
 * Serves spans of a file's committed state to an export whose canvas holds
 * only a window of it. `hold` resolves null when a span cannot be read.
 */
export interface ExportWindow {
  /** Frames one span holds at most. */
  spanFrames: number;
  hold: (startFrame: number, endFrame: number) => Promise<ExportSpan | null>;
}

export interface ImageExportSource {
  /** The committed spectrogram to draw, as an FBO texture. Null with a window. */
  texture: Texture | null;
  /** Per-band packing offsets, lengths, and time strides. Null with a window. */
  metadataTexture: Texture | null;
  spectrogramData: SpectrogramData;
  /** Where the spans come from when the canvas cannot hold the whole file. */
  window?: ExportWindow | null;
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
      ...createDefaultUniforms(),
      minDb: { value: -90 },
      maxDb: { value: -10 },
      colormapMode: { value: 1 },
      colormapTex: { value: null },
      timeTaps: { value: 8 },
      tileUvMin: { value: new Vector2(0, 0) },
      tileUvSize: { value: new Vector2(1, 1) },
      sourceSpanPixels: { value: 1.0 },
      tileOriginPx: { value: new Vector2(0, 0) },
      probeMode: { value: false },
      probeMinDb: { value: PROBE_MIN_DB },
      probeMaxDb: { value: PROBE_MAX_DB },
      wrapMode: { value: 0 },
    },
    vertexShader: passThroughVert,
    fragmentShader: exportFrag,
    glslVersion: GLSL3,
  });
  return exportMaterial;
}

function applySourceUniforms(material: RawShaderMaterial, source: ImageExportSource, colormap: ColormapId): void {
  const { spectrogramData: data } = source;
  const uniforms = material.uniforms;
  // A window rebinds these per span; without one the whole file stays bound.
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

/** The image columns one source span serves, and the frames it has to hold. */
interface ExportStrip {
  x0: number;
  x1: number;
  startFrame: number;
  endFrame: number;
}

/**
 * The image cut into runs of columns, each narrow enough for one span of the
 * source to serve. Without a window the whole image is one strip.
 */
function exportStrips(source: ImageExportSource, columns: number): ExportStrip[] {
  const { numFrames } = source.spectrogramData;
  const window = source.window;
  if (!window || window.spanFrames >= numFrames) {
    return [{ x0: 0, x1: columns, startFrame: 0, endFrame: numFrames }];
  }
  // A column of margin each side, so the footprint average at a strip's edge
  // still reads frames the span holds.
  const framesPerColumn = numFrames / columns;
  const width = Math.max(1, Math.floor(window.spanFrames / framesPerColumn) - 2);
  const strips: ExportStrip[] = [];
  for (let x0 = 0; x0 < columns; x0 += width) {
    const x1 = Math.min(columns, x0 + width);
    strips.push({
      x0,
      x1,
      startFrame: Math.max(0, (x0 - 1) * framesPerColumn),
      endFrame: Math.min(numFrames, (x1 + 1) * framesPerColumn),
    });
  }
  return strips;
}

/** The frames a bound source lays out. */
interface BoundSpan {
  startFrame: number;
  frames: number;
}

/**
 * Binds the span that serves `strip`. `spanPixels` is the image width the
 * per-pixel time footprint is measured against, which stays the final image's
 * even while the probe renders smaller. Resolves null when the read failed.
 */
async function holdStrip(
  material: RawShaderMaterial,
  source: ImageExportSource,
  strip: ExportStrip,
  spanPixels: number,
): Promise<BoundSpan | null> {
  const { numFrames } = source.spectrogramData;
  if (!source.window) {
    material.uniforms.sourceSpanPixels.value = spanPixels;
    return { startFrame: 0, frames: numFrames };
  }
  const span = await source.window.hold(strip.startFrame, strip.endFrame);
  // A span short of the strip would draw clamped values as if they were the
  // file's, so the export stops instead.
  if (!span || span.startFrame > strip.startFrame || span.endFrame < strip.endFrame) return null;
  const frames = span.endFrame - span.startFrame;
  material.uniforms.sourceSpectrogramTex.value = span.texture;
  material.uniforms.sourceMetadataTex.value = span.metadataTexture;
  material.uniforms.sourceFrameCount.value = frames;
  material.uniforms.sourceSpanPixels.value = (spanPixels * frames) / numFrames;
  return { startFrame: span.startFrame, frames };
}

/** Image columns [x0, x0 + count) as a UV range on the bound span. */
function spanUvX(
  source: ImageExportSource,
  span: BoundSpan,
  x0: number,
  count: number,
  columns: number,
): { min: number; size: number } {
  const { numFrames } = source.spectrogramData;
  const framesPerColumn = numFrames / columns;
  return {
    min: (x0 * framesPerColumn - span.startFrame) / span.frames,
    size: (count * framesPerColumn) / span.frames,
  };
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
  source: ImageExportSource,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const strips = exportStrips(source, width);
  const tilesY = Math.ceil(height / TILE_SIZE);
  let totalTiles = 0;
  for (const strip of strips) totalTiles += Math.ceil((strip.x1 - strip.x0) / TILE_SIZE) * tilesY;
  let target: WebGLRenderTarget | null = null;
  let done = 0;

  try {
    for (const strip of strips) {
      const span = await holdStrip(material, source, strip, width);
      if (!span) throw new Error("The export could not read the file");
      // Tiles are laid out bottom-up to match GL's pixel origin; the readback
      // is flipped into the canvas's top-down rows as each tile lands.
      for (let ty = 0; ty < tilesY; ty++) {
        const y0 = ty * TILE_SIZE;
        const tileH = Math.min(TILE_SIZE, height - y0);
        for (let x0 = strip.x0; x0 < strip.x1; x0 += TILE_SIZE) {
          const tileW = Math.min(TILE_SIZE, strip.x1 - x0);

          if (!target) {
            target = createByteTarget(tileW, tileH);
          } else if (target.width !== tileW || target.height !== tileH) {
            target.setSize(tileW, tileH);
          }

          const uvX = spanUvX(source, span, x0, tileW, width);
          (material.uniforms.tileUvMin.value as Vector2).set(uvX.min, y0 / height);
          (material.uniforms.tileUvSize.value as Vector2).set(uvX.size, tileH / height);
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
    material.uniforms.timeTaps.value = computeTimeTaps(
      source.spectrogramData.numFrames,
      width,
      source.spectrogramData.synthesisMetadata.bandStepLog2s,
    );

    const range = await measureRange(gl, material, source, width, height);
    material.uniforms.minDb.value = range.minDb;
    material.uniforms.maxDb.value = range.maxDb;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create a 2D context for the exported image");

    await renderTiles(gl, material, source, ctx, width, height, onProgress);
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
  source: ImageExportSource,
  width: number,
  height: number,
): Promise<DbRange> {
  const scale = PROBE_LONG_EDGE / Math.max(width, height);
  const probeW = Math.max(2, Math.round(width * scale));
  const probeH = Math.max(2, Math.round(height * scale));

  const strips = exportStrips(source, probeW);
  const chunks: Uint8Array[] = [];
  let target: WebGLRenderTarget | null = null;
  try {
    material.uniforms.probeMode.value = true;
    for (const strip of strips) {
      const span = await holdStrip(material, source, strip, width);
      if (!span) throw new Error("The export could not read the file");
      const stripW = strip.x1 - strip.x0;
      if (!target) target = createByteTarget(stripW, probeH);
      else if (target.width !== stripW || target.height !== probeH) target.setSize(stripW, probeH);
      const uvX = spanUvX(source, span, strip.x0, stripW, probeW);
      (material.uniforms.tileUvMin.value as Vector2).set(uvX.min, 0);
      (material.uniforms.tileUvSize.value as Vector2).set(uvX.size, 1);
      (material.uniforms.tileOriginPx.value as Vector2).set(strip.x0, 0);
      chunks.push(await renderMaterialToBytes(gl, material, target));
    }
  } finally {
    material.uniforms.probeMode.value = false;
    target?.dispose();
  }
  // The range comes from a histogram, so the strips need no reassembly.
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const probe = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    probe.set(chunk, at);
    at += chunk.length;
  }
  return computeAutoRange(probe);
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
