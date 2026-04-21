#include "effect-common.glsl";
#include "effect-wrapper.glsl"

uniform int synthesizeType;

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb) {
  vec2 polarValueL;
  vec2 polarValueR;

  if (synthesizeType == 0) { // Noise
    // Use a small offset to de-correlate multiple random calls
    vec2 seed1 = coords.dest;
    vec2 seed2 = coords.dest + vec2(12.34, 56.78);
    vec2 seed3 = coords.dest + vec2(43.21, 87.65);
    vec2 seed4 = coords.dest + vec2(21.43, 65.87);

    // Left Channel
    float amplitudeL = random(seed1 + random(seed2));
    float phaseL = (random(seed3 + random(seed4)) * 2.0 - 1.0) * PI;
    polarValueL = vec2(amplitudeL, phaseL);

    // Right Channel - use swizzled seeds for stereo separation
    float amplitudeR = random(seed1.yx + random(seed2.yx));
    float phaseR = (random(seed3.yx + random(seed4.yx)) * 2.0 - 1.0) * PI;
    polarValueR = vec2(amplitudeR, phaseR);
  } else if (synthesizeType == 1) { // Sine
    float amplitude = 1.0;
    float phase = 0.0;
    polarValueL = vec2(amplitude, phase);
    polarValueR = vec2(amplitude, phase);
  } else if (synthesizeType == 2) { // Impulse
    // Write the exact Gabor-space representation of a Dirac at the brush start:
    //   magnitude: Gaussian window centered at the anchor, half-width ~Q/f
    //   phase:     -2π·f·T  (uniform across atoms, for global phase convention)
    vec4 meta       = getDestMetadata(coords.dest);
    float fHz       = max(meta.a, 1e-6);
    float anchorSec = brushBottomLeftUv.x * destFrameCount / destSampleRate;
    float pixelSec  = coords.dest.x * destFrameCount / destSampleRate;
    float distSec   = pixelSec - anchorSec;
    float widthSec  = (destBandsPerOctave * 0.7) / fHz;
    float arg       = distSec / widthSec;
    float amplitude = exp(-arg * arg);
    float phase     = -TWO_PI * fHz * anchorSec;
    polarValueL = vec2(amplitude, phase);
    polarValueR = vec2(amplitude, phase);
  }
  else {
    polarValueL = vec2(1.0, 0.0);
    polarValueR = vec2(1.0, 0.0);
  }

  return vec4(polarValueL, polarValueR);
}
