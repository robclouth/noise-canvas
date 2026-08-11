#include "effect-common.glsl";

// Offline still-image render of the spectrogram. Differs from display.frag in
// three ways that only matter at print resolution: each output pixel integrates
// its whole time footprint instead of point-sampling one position, bands blend
// with a cubic instead of a linear ramp, and the result is dithered before it is
// quantised to 8 bits.

uniform float minDb;
uniform float maxDb;

// 0 = editor colours (grey mono / orange-blue stereo), 1 = colormapTex ramp.
uniform int colormapMode;
uniform sampler2D colormapTex;

// Samples taken across each output pixel's time footprint.
uniform int timeTaps;

// The sub-rectangle of the full image this draw covers, in image UV. Rendering
// proceeds in tiles so no single draw call runs long enough to trip a GPU
// watchdog, and so the render target stays small.
uniform vec2 tileUvMin;
uniform vec2 tileUvSize;
// Full image size in pixels, and this tile's origin within it.
uniform vec2 imageSize;
uniform vec2 tileOriginPx;

// When set, output the normalised level over [probeMinDb, probeMaxDb] instead of
// a colour. The histogram of that pass is what picks minDb/maxDb.
uniform bool probeMode;
uniform float probeMinDb;
uniform float probeMaxDb;

const float LN10_OVER_20 = 0.115129254649702;

/**
 * Peak-weighted average of a band row across one output pixel's time footprint.
 * A plain mean washes transients out at print resolution, where a pixel can span
 * hundreds of analysis frames; the fourth-power mean keeps a ridge that occupies
 * part of the footprint bright while still averaging the noise floor down.
 * Returns linear magnitude for both channels.
 */
vec2 sampleRowFootprint(float bandIndex, float uvX, float halfWidthUv) {
  float clampedBand = clamp(bandIndex, 0.0, sourceBandCount - 1.0);
  float rowUvY = 1.0 - (clampedBand + 0.5) / sourceBandCount;

  int taps = clamp(timeTaps, 1, 64);
  float n = float(taps);
  vec2 acc = vec2(0.0);

  for (int i = 0; i < taps; i++) {
    float offset = ((float(i) + 0.5) / n - 0.5) * 2.0 * halfWidthUv;
    vec4 magPhase = sampleSourceInterp(vec2(clamp(uvX + offset, 0.0, 1.0), rowUvY));
    vec2 mag = vec2(magPhase.x, magPhase.z);
    vec2 squared = mag * mag;
    acc += squared * squared;
  }

  return sqrt(sqrt(acc / n));
}

vec2 catmullRom(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return 0.5 * ((2.0 * p1) + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
                (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
}

/**
 * S-curve on the normalised level. Sinks the noise floor to black and spreads
 * the mid levels apart, so harmonics separate instead of merging into one bright
 * mass — without the hard clip that would flatten the quiet detail above the floor.
 */
float toneCurve(float v) {
  float s = v * v * (3.0 - 2.0 * v);
  return mix(v, s, 0.6);
}

float normalizeDb(float db, float lo, float hi) {
  return clamp((db - lo) / max(hi - lo, 1.0e-3), 0.0, 1.0);
}

void main() {
  vec2 uv = tileUvMin + vUv * tileUvSize;

  // Bands blend with a Catmull-Rom through four rows. At export sizes a band
  // covers many pixels, and the linear ramp the live view uses shows up as
  // facets along every harmonic. The result is clamped to the two central rows
  // so the cubic cannot ring into dark halos around bright ridges.
  float bandIndexF = (1.0 - uv.y) * sourceBandCount - 0.5;
  float base = floor(bandIndexF);
  float bandFrac = bandIndexF - base;

  float halfWidthUv = 0.5 / max(imageSize.x, 1.0);
  vec2 m0 = sampleRowFootprint(base - 1.0, uv.x, halfWidthUv);
  vec2 m1 = sampleRowFootprint(base, uv.x, halfWidthUv);
  vec2 m2 = sampleRowFootprint(base + 1.0, uv.x, halfWidthUv);
  vec2 m3 = sampleRowFootprint(base + 2.0, uv.x, halfWidthUv);

  // Blending in the log domain keeps a decay reading as a straight fade, and
  // lands directly in the units the dB mapping wants.
  const float FLOOR = 1.0e-7;
  vec2 l0 = log(m0 + FLOOR);
  vec2 l1 = log(m1 + FLOOR);
  vec2 l2 = log(m2 + FLOOR);
  vec2 l3 = log(m3 + FLOOR);
  vec2 blended = clamp(catmullRom(l0, l1, l2, l3, bandFrac), min(l1, l2), max(l1, l2));

  vec2 db = blended / LN10_OVER_20;

  // Level driving the ramp: the single channel for mono, the RMS of both for
  // stereo, so a hard-panned sound is not dimmed relative to a centred one.
  vec2 mag = exp(blended);
  float combinedMag = sourceChannelCount == 1 ? mag.x : sqrt(0.5 * dot(mag, mag));
  float combinedDb = log(combinedMag + FLOOR) / LN10_OVER_20;

  if (probeMode) {
    outColor = vec4(vec3(normalizeDb(combinedDb, probeMinDb, probeMaxDb)), 1.0);
    return;
  }

  vec3 color;
  if (colormapMode == 0) {
    if (sourceChannelCount == 1) {
      color = vec3(toneCurve(normalizeDb(db.x, minDb, maxDb)));
    } else {
      float left = toneCurve(normalizeDb(db.x, minDb, maxDb));
      float right = toneCurve(normalizeDb(db.y, minDb, maxDb));
      color = vec3(left, left * 0.5, 0.0) + vec3(0.0, right * 0.5, right);
    }
  } else {
    color = texture(colormapTex, vec2(toneCurve(normalizeDb(combinedDb, minDb, maxDb)), 0.5)).rgb;
  }

  // Triangular dither at half a code value. A spectrogram is mostly wide, smooth
  // dark gradients, which band visibly once quantised to 8 bits.
  vec2 pixel = tileOriginPx + gl_FragCoord.xy;
  float noise = hash12(pixel) - hash12(pixel + 37.17);
  color += noise / 255.0;

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
