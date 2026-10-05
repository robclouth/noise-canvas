#include "../glsl/effect-common.glsl"

// One time in seconds per column, in the red channel of probeTex; each column
// writes the onsets around it.
uniform sampler2D probeTex;

void main() {
  float tSec = texelFetch(probeTex, ivec2(int(gl_FragCoord.x), 0), 0).r;
  outColor = sourceOnsetsAround(tSec);
}
