// Modulator precompute pass. Evaluates every modulator's stereo output once per
// pixel and writes them to two RGBA float targets that effect shaders sample.
// Pulling the heavy evaluator (evalModulatorAtUv: pattern/sequencer/envelope +
// nested modulation) out of the effects means it compiles only here, not into
// every effect program, and runs once per step instead of per effect/pass.
#include "effect-common.glsl"

// outColor (location 0) comes from common.glsl; add the second MRT target.
layout(location = 1) out vec4 outMod1;

// True only when some modulator parameter is itself modulated by a modulator or
// macro (nested modulation). When false the nested sources are a no-op at every
// consumer, so the per-pixel source evaluation is skipped entirely.
uniform bool nestedModulationActive;

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

  // The nested sources depend only on the source modulator and uv, so evaluate
  // them once here and share across all three outputs rather than letting each
  // getModulation re-evaluate them.
  float nested[NUM_MODULATORS] = float[NUM_MODULATORS](0.0, 0.0, 0.0);
  if (nestedModulationActive) {
    evalNestedSources(destUv, audioLevelDb, nested);
  }

  vec2 m0 = getModulationWithNested(destUv, 0, nestedModulationActive, nested, audioLevelDb);
  vec2 m1 = getModulationWithNested(destUv, 1, nestedModulationActive, nested, audioLevelDb);
  vec2 m2 = getModulationWithNested(destUv, 2, nestedModulationActive, nested, audioLevelDb);

  outColor = vec4(m0, m1);
  outMod1 = vec4(m2, 0.0, 0.0);
}
