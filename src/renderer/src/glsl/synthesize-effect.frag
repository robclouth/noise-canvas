precision highp float;
in vec2 vUv;

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
  }
  else {
    polarValueL = vec2(1.0, 0.0);
    polarValueR = vec2(1.0, 0.0);
  }

  return vec4(polarValueL, polarValueR);
}
