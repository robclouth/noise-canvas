import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat } from "three";
import { metadataTextureRows, type BandLayout } from "./band-layout";

/** A band layout's metadata texture, as the stroke shaders sample it. */
export function bandMetadataTexture(layout: BandLayout, sampleRate: number): DataTexture {
  const texture = new DataTexture(metadataTextureRows(layout, sampleRate), layout.numBands, 2, RGBAFormat, FloatType);
  texture.internalFormat = "RGBA32F";
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
