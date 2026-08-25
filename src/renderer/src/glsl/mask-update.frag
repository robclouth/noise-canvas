// Mask Update Shader
// Stores effective weight (envelope * intensity) for single-stroke mode.
// The target blends with MAX, so each dab writes only its own weight and the
// strongest one across the stroke survives.

#include "effect-common.glsl"

void main() {
  vec2 packedUv = vUv;
  vec2 unpackedUv = packedToUnpackedUv(destInverseMapTex, packedUv, destFrameCount, destBandCount);

  // Outside the brush footprint the weight is zero, which MAX discards — bail
  // before the expensive weight evaluation.
  if (brushWeightIsZero(unpackedUv)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float audioLevelDb = getAudioLevelDb(unpackedUv);
  vec2 envelopeWeight = getBrushWeight(unpackedUv, audioLevelDb);

  vec2 intensity = resolveParameterAt(brushIntensity, unpackedUv, 0, audioLevelDb);

  // Mask is a single scalar per pixel; use the stronger of L/R so the gate
  // opens wherever either channel has contributed.
  vec2 combinedWeight = envelopeWeight * intensity;
  float newWeight = max(combinedWeight.x, combinedWeight.y);

  outColor = vec4(newWeight, 0.0, 0.0, 1.0);
}
