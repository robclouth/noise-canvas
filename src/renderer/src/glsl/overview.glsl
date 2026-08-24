// The decimated whole-file view the display falls back to wherever the packed
// texture holds only a window. It keeps the file's dyadic layout with each
// band's step exponent shifted by the decimation, so the ordinary packed
// addressing reads it with no special case; only the stored value differs.
uniform sampler2D overviewTex;      // RG16F: dB per channel, before the full-scale offset
uniform sampler2D overviewMetaTex;
uniform bool overviewActive;
// Bins over which the display crosses from the window to the overview.
const float OVERVIEW_FADE_BINS = 8.0;

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
 * How much of a read the overview should supply at this position: 0 inside the
 * window, 1 beyond it, ramping across the last OVERVIEW_FADE_BINS bins.
 */
float overviewBlend(vec2 uv, sampler2D metaTex, float frameCount, float bandCount) {
  if (!overviewActive) return 0.0;
  PackedBand band = fetchPackedBand(metaTex, floor((1.0 - uv.y) * bandCount));
  // A whole-file texture has no seam; without this the fade would fire at the
  // file's own first and last bins, where nothing is missing.
  if (bandIsWholeFile(band)) return 0.0;
  float margin = bandResidencyMargin(band, uv.x * frameCount);
  return 1.0 - clamp(margin / OVERVIEW_FADE_BINS, 0.0, 1.0);
}
