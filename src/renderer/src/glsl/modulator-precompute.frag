// Modulator precompute pass. Evaluates every modulator's stereo output once per
// pixel and writes them to two RGBA float targets that effect shaders sample.
// Pulling the heavy evaluator (evalModulatorAtUv: pattern/sequencer/envelope +
// nested modulation) out of the effects means it compiles only here, not into
// every effect program, and runs once per step instead of per effect/pass.
#include "effect-common.glsl"

// outColor (location 0) comes from common.glsl; add the second MRT target.
layout(location = 1) out vec4 outMod1;

void main() {
  vec2 destUv = packedToUnpackedUv(destInverseMapTex, vUv, destFrameCount, destBandCount);

  // Effects sample these targets only inside the brush footprint, so pixels the
  // brush cannot reach never have their modulators read — skip evaluating them.
  if (brushWeightIsZero(destUv)) {
    outColor = vec4(0.0);
    outMod1 = vec4(0.0);
    return;
  }

  float audioLevelDb = getAudioLevelDb(destUv);

  vec2 m0 = getModulation(destUv, 0, true, audioLevelDb);
  vec2 m1 = getModulation(destUv, 1, true, audioLevelDb);
  vec2 m2 = getModulation(destUv, 2, true, audioLevelDb);

  outColor = vec4(m0, m1);
  outMod1 = vec4(m2, 0.0, 0.0);
}
