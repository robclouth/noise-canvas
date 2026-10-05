#include "effect-common.glsl";
#include "effect-wrapper.glsl"

uniform int synthesizeType;

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb) {
  vec2 polarValueL;
  vec2 polarValueR;

  if (synthesizeType == 0) { // Noise
    // One draw per salt for each channel's amplitude and phase.
    float amplitudeL = randomAt(coords.dest, 10u);
    float phaseL = (randomAt(coords.dest, 11u) * 2.0 - 1.0) * PI;
    polarValueL = vec2(amplitudeL, phaseL);

    float amplitudeR = randomAt(coords.dest, 12u);
    float phaseR = (randomAt(coords.dest, 13u) * 2.0 - 1.0) * PI;
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
    // Distance from the brush start measured in brush space, so a brush that
    // wraps the canvas anchors its wrapped half to the same impulse — one loop
    // earlier in absolute time.
    float distUv    = getEffectiveBrushOffset(coords.dest).x;
    float distSec   = distUv * destFrameCount / destSampleRate;
    float widthSec  = (destBandsPerOctave * 0.7) / fHz;
    float arg       = distSec / widthSec;
    float amplitude = exp(-arg * arg);
    // The impulse's phase is set against the file's absolute time, in exact
    // turns, so it lands the same however far into the file the brush sits.
    float phase     = phaseOfTurns(turnsOver(-1.0, destBandRate(coords.dest), destBrushStartFrames(coords.dest)));
    polarValueL = vec2(amplitude, phase);
    polarValueR = vec2(amplitude, phase);
  }
  else {
    polarValueL = vec2(1.0, 0.0);
    polarValueR = vec2(1.0, 0.0);
  }

  return vec4(polarValueL, polarValueR);
}
