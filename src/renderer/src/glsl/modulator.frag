precision highp float;
varying vec2 vUv;

#include "common.glsl"

uniform vec2 brushCenterUv;
uniform vec2 brushSizeUv;

#include "modulation-common.glsl"

uniform int modulatorIndex;

void main() {
  int shape = int(modulators[modulatorIndex].modulatorPatternShape);

  // If the shape is selected scale, scale the uvs differently.
  vec2 multiplier = vec2(shape == 11 ? 1.0 : 16.0, shape == 11 ? 1.0 / 12.0 : 48.0);
  float v = getModulation(vUv * multiplier, modulatorIndex, true);
  gl_FragColor = vec4(vec3(v), 1.0);
}