#include "../glsl/effect-common.glsl"

// One case per column. For turnsOver, row 0: k, the rate's float and its
// remainder, the frame offset; row 1: the whole frames as a multiple of 4096
// and the rest, k's remainder. For framesAtSec, row 0: seconds, sample rate.
uniform sampler2D probeTex;
uniform int probeMode;

void main() {
  int column = int(gl_FragCoord.x);
  vec4 row0 = texelFetch(probeTex, ivec2(column, 0), 0);
  vec4 row1 = texelFetch(probeTex, ivec2(column, 1), 0);
  if (probeMode == 1) {
    Frames frames = framesAtSec(row0.x, row0.y);
    outColor = vec4(float(frames.whole >> 12), float(frames.whole & 0xFFF), frames.offset, 0.0);
    return;
  }
  Turns turns = turnsOver(vec2(row0.x, row1.z), row0.yz, Frames(int(row1.x) + int(row1.y), row0.w));
  outColor = vec4(turns.fraction, 0.0, phaseOfTurns(turns), 0.0);
}
