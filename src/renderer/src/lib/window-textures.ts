import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  RGFormat,
  type PixelFormatGPU,
} from "three";
import type { SpectrogramData } from "../store/types";
import { gatherPixelRanges } from "./pixel-ranges";
import {
  buildWindowInverseMap,
  buildWindowMetadata,
  isWholeFileWindow,
  windowFileRanges,
  type WindowLayout,
} from "./window-layout";

/** The three textures a StrokeRenderer reads a resident span through. */
export interface WindowTextures {
  packed: DataTexture;
  inverse: DataTexture;
  meta: DataTexture;
}

function configure(texture: DataTexture, internalFormat: PixelFormatGPU): DataTexture {
  texture.internalFormat = internalFormat;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The file's own one-row metadata texture. The display reads band geometry
 * through it whatever window the paint textures hold, since its committed
 * base is always file-sized.
 */
export function buildFileMetadataTexture(data: SpectrogramData): DataTexture {
  return configure(new DataTexture(data.metadata, data.numBands, 1, RGBAFormat, FloatType), "RGBA32F");
}

/** The window's packed magnitudes, gathered out of the file array and padded to its texture. */
export function gatherWindowPacked(packedData: Float32Array, window: WindowLayout): Float32Array {
  const padded = new Float32Array(window.textureWidth * window.textureHeight * 4);
  padded.set(gatherPixelRanges(packedData, windowFileRanges(window)));
  return padded;
}

/**
 * The packed, inverse-map and metadata textures for `window`.
 *
 * A whole-file window uploads the file's own arrays, and its metadata stays one
 * row, which is what marks a texture as holding no window at all.
 */
export function buildWindowTextures(data: SpectrogramData, window: WindowLayout): WindowTextures {
  const whole = isWholeFileWindow(window);
  const packedData = whole ? data.packedData : gatherWindowPacked(data.packedData, window);
  const inverseMap = whole ? data.inverseMap : buildWindowInverseMap(window);
  const metadata = whole ? data.metadata : buildWindowMetadata(window, data.metadata);

  return {
    packed: configure(
      new DataTexture(packedData, window.textureWidth, window.textureHeight, RGBAFormat, FloatType),
      "RGBA32F",
    ),
    inverse: configure(
      new DataTexture(inverseMap, window.textureWidth, window.textureHeight, RGFormat, FloatType),
      "RG32F",
    ),
    meta: configure(new DataTexture(metadata, window.numBands, whole ? 1 : 2, RGBAFormat, FloatType), "RGBA32F"),
  };
}
