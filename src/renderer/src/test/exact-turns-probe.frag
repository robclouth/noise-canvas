#include "../glsl/effect-common.glsl"

// One case per column. Row 0: k, the rate's float and its remainder, the frame
// offset. Row 1: the whole frames as a multiple of 4096 and the rest.
uniform sampler2D probeTex;

void main() {
  int column = int(gl_FragCoord.x);
  vec4 factors = texelFetch(probeTex, ivec2(column, 0), 0);
  vec2 whole = texelFetch(probeTex, ivec2(column, 1), 0).rg;
  Turns turns = turnsOver(factors.x, factors.yz, Frames(int(whole.x) + int(whole.y), factors.w));
  outColor = vec4(turns.fraction, turns.approx, phaseOfTurns(turns), 0.0);
}
