// Mask Update Shader
// Stores effective weight (envelope * intensity) for single-stroke mode
// Uses manual max calculation instead of relying on GPU blend mode

#include "effect-common.glsl"

uniform sampler2D currentMaskTex;

void main() {
  vec2 packedUv = vUv;
  vec2 unpackedUv = packedToUnpackedUv(destInverseMapTex, packedUv, destFrameCount, destBandCount);

  float envelopeWeight = getBrushWeight(unpackedUv);
  
  // Effective weight is envelope * intensity (same calculation as in applyBrush)
  float newWeight = envelopeWeight * brushIntensity.value;
  
  // Read current mask value and take maximum
  float currentWeight = texture(currentMaskTex, packedUv).r;
  float maxWeight = max(currentWeight, newWeight);
  
  outColor = vec4(maxWeight, 0.0, 0.0, 1.0);
}
