precision highp float;
varying vec2 vUv;

#define PI 3.141592653589793

#include "modulation-common.glsl"

void main() {
  int shape = int(modulatorPatternShape);
  float v = getModulation(vUv * vec2(shape == 11 ? 1.0 : 16.0, shape == 11 ? 1.0/12.0 : 48.0));
  gl_FragColor = vec4(vec3(v), 1.0);
}