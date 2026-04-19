// Mask Update Shader
// Stores effective weight (envelope * intensity) for single-stroke mode
// Uses manual max calculation instead of relying on GPU blend mode

#include "effect-common.glsl"

uniform sampler2D currentMaskTex;

void main() {
  vec2 packedUv = vUv;
  vec2 unpackedUv = packedToUnpackedUv(destInverseMapTex, packedUv, destFrameCount, destBandCount);

  float audioLevelDb = getAudioLevelDb(unpackedUv);
  float envelopeWeight = getBrushWeight(unpackedUv, audioLevelDb);

  float intensity = applyModulation(
    brushIntensity.value, brushIntensity.minValue, brushIntensity.maxValue,
    brushIntensity.modulationAmounts, brushIntensity.contextualModAmounts, unpackedUv, 0, audioLevelDb
  );

  float newWeight = envelopeWeight * intensity;
  
  // Read current mask value and take maximum
  float currentWeight = texture(currentMaskTex, packedUv).r;
  float maxWeight = max(currentWeight, newWeight);
  
  outColor = vec4(maxWeight, 0.0, 0.0, 1.0);
}
