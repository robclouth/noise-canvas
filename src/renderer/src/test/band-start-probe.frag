#include "../glsl/effect-common.glsl"

// One band per column; each writes its first packed texel, split as a multiple
// of 4096 and the rest so the float carries it exactly.
uniform sampler2D probeMetaTex;

void main() {
  int start = bandStartTexel(probeMetaTex, float(int(gl_FragCoord.x)));
  outColor = vec4(float(start / 4096), float(start % 4096), 0.0, 0.0);
}
