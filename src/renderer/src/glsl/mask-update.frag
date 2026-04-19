// Mask Update Shader
// Stores effective weight (envelope * intensity) for single-stroke mode
// Uses manual max calculation instead of relying on GPU blend mode

#include "effect-common.glsl"

uniform sampler2D currentMaskTex;

void main() {
  vec2 packedUv = vUv;
  vec2 unpackedUv = packedToUnpackedUv(destInverseMapTex, packedUv, destFrameCount, destBandCount);

  float audioLevelDb = getAudioLevelDb(unpackedUv);
  vec2 envelopeWeight = getBrushWeight(unpackedUv, audioLevelDb);

  vec2 intensity = applyModulation(
    brushIntensity.value, brushIntensity.minValue, brushIntensity.maxValue,
    brushIntensity.modulationAmounts, brushIntensity.contextualModAmounts, brushIntensity.macroAmounts, unpackedUv, 0, audioLevelDb
  );

  // Mask is a single scalar per pixel; use the stronger of L/R so the gate
  // opens wherever either channel has contributed.
  vec2 combinedWeight = envelopeWeight * intensity;
  float newWeight = max(combinedWeight.x, combinedWeight.y);
  
  // Read current mask value and take maximum
  float currentWeight = texture(currentMaskTex, packedUv).r;
  float maxWeight = max(currentWeight, newWeight);
  
  outColor = vec4(maxWeight, 0.0, 0.0, 1.0);
}
