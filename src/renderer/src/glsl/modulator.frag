#include "common.glsl"

uniform vec2 brushBottomLeftUv;
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
  
  // Stereo-aware modulator output — orange for L, blue for R (matches
  // display.frag stereo coloring). When stereoSpread == 0 the two lanes are
  // equal and the preview is yellow (mono).
  vec2 v = getModulation(vUv, modulatorIndex, true, audioLevelDb);
  vec3 leftColor  = vec3(v.x, v.x * 0.5, 0.0);
  vec3 rightColor = vec3(0.0, v.y * 0.5, v.y);
  outColor = vec4(leftColor + rightColor, 1.0);
}