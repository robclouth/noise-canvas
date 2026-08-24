// The decimated whole-file view the display falls back to wherever the packed
// texture holds only a window. It keeps the file's dyadic layout with each
// band's step exponent shifted by the decimation, so the ordinary packed
// addressing reads it with no special case; only the stored value differs.
uniform sampler2D overviewTex;      // RG16F: dB per channel, before the full-scale offset
uniform sampler2D overviewMetaTex;
uniform bool overviewActive;
// Frames one overview bin covers, as a power of two. One number for the whole
// overview, so the display prefers it at the same zoom in every band.
uniform float overviewStepLog2;
// Bins over which the display crosses from the window to the overview.
const float OVERVIEW_FADE_BINS = 8.0;
// Overview bins per screen pixel between which the display crosses from the
// window to the overview. Below one bin per pixel the overview is coarser than
// the display and the window still resolves more; above it the overview loses
// nothing and the window's own point sample is the read that aliases.
const float OVERVIEW_ZOOM_LO = 1.0;
const float OVERVIEW_ZOOM_HI = 4.0;

/**
 * Magnitudes from the overview at an unpacked UV, in the same
 * (magL, phaseL, magR, phaseR) shape a packed read returns. Phase is zero: the
 * overview holds none, and the display reads none.
 */
vec4 sampleOverviewMagnitudes(vec2 uv, float frameCount, float bandCount) {
  float bandIndex, bandStartOffset, timeIndex0, timeIndex1, fraction;
  bool resident;
  packedInterpBins(uv, overviewMetaTex, frameCount, bandCount,
                   bandIndex, bandStartOffset, timeIndex0, timeIndex1, fraction, resident);

  ivec2 texSize = textureSize(overviewTex, 0);
  vec2 db0 = texelFetch(overviewTex, packedTexel(bandStartOffset + timeIndex0, texSize), 0).rg;
  vec2 db1 = texelFetch(overviewTex, packedTexel(bandStartOffset + timeIndex1, texSize), 0).rg;
  vec2 db = mix(db0, db1, fraction);

  // Back to magnitude, so the caller's band interpolation and dB mapping stay
  // exactly what they are for a full-precision read.
  vec2 mag = max(pow(vec2(10.0), db * 0.05) - 1e-7, vec2(0.0));
  return vec4(mag.x, 0.0, mag.y, 0.0);
}

/**
 * How much of a read the overview should supply once its bins are near or below
 * one screen pixel. It depends on the zoom alone, so it holds the same value on
 * both sides of a window edge and across every band boundary, and puts no step
 * at either.
 */
float overviewZoomBlend(float framesPerPixel) {
  float binsPerPixel = framesPerPixel / exp2(overviewStepLog2);
  float span = log2(OVERVIEW_ZOOM_HI / OVERVIEW_ZOOM_LO);
  return clamp(log2(binsPerPixel / OVERVIEW_ZOOM_LO) / span, 0.0, 1.0);
}

/**
 * How much of a read the overview should supply at this position: the larger of
 * the seam fade across the window's last OVERVIEW_FADE_BINS bins and the zoom
 * blend.
 */
float overviewBlend(vec2 uv, sampler2D metaTex, float frameCount, float bandCount) {
  if (!overviewActive) return 0.0;
  // Taken before any branch on the band, which varies within a quad.
  float framesPerPixel = fwidth(uv.x) * frameCount;
  PackedBand band = fetchPackedBand(metaTex, floor((1.0 - uv.y) * bandCount));
  // A whole-file texture has no seam; without this the fade would fire at the
  // file's own first and last bins, where nothing is missing.
  if (bandIsWholeFile(band)) return 0.0;
  float margin = bandResidencyMargin(band, uv.x * frameCount);
  float seam = 1.0 - clamp(margin / OVERVIEW_FADE_BINS, 0.0, 1.0);
  return max(seam, overviewZoomBlend(framesPerPixel));
}
