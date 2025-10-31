precision highp float;
in vec2 vUv;
out vec4 fragColor;

#include "common.glsl"

uniform vec2 brushCenterUv;
uniform vec2 brushSizeUv;

#include "modulation-common.glsl"

uniform int modulatorIndex;
uniform sampler2D testTexture;

void main() {
  int shape = int(modulators[modulatorIndex].modulatorPatternShape);

  // If the shape is selected scale, scale the uvs differently.
  vec2 multiplier = vec2(shape == 11 ? 1.0 : 16.0, shape == 11 ? 1.0 / 12.0 : 48.0);
  
  // Use the texture to get the audio level
  float audioLevel = texture(testTexture, vUv).r;
  float audioLevelDb = 20.0 * log(audioLevel + 0.000001) / log(10.0);
  
  float v = getModulation(vUv, modulatorIndex, true, audioLevelDb);
  fragColor = vec4(vec3(v), 1.0);
}