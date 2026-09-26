#include "effect-common.glsl"

// Fills the automaton's grid from the sound under the brush: each cell hears
// the source at its place in the brush, both channels folded into one, with no
// hidden state, and the seed (every hidden channel on, no sound) planted in the
// middle cell. Mirrors readGrid and soundState in lib/nca, which build the same
// state for training.

layout(location = 1) out vec4 outState1;
layout(location = 2) out vec4 outState2;

uniform int ncaGrid;

const float NCA_DB_RANGE = 90.0;

float ncaLevelOf(float magnitude) {
  float db = 20.0 * log(max(magnitude, 1e-12)) / log(10.0);
  return max(1.0 + db / NCA_DB_RANGE, 0.0);
}

void main() {
  ivec2 cell = ivec2(floor(vUv * float(ncaGrid)));
  vec2 local = (vec2(cell) + 0.5) / float(ncaGrid);
  vec2 sourceUv = destUvToSourceUv(brushBottomLeftUv + local * brushSizeUv);

  vec4 state0 = vec4(0.0);
  vec4 state1 = vec4(0.0);
  vec4 state2 = vec4(0.0);
  if (sourceUv.y >= 0.0 && sourceUv.y < 1.0) {
    vec2 at = vec2(fract(sourceUv.x), sourceUv.y);
    vec4 texel = readPackedData(at, sourceSpectrogramTex, sourceMetadataTex, sourceFrameCount, sourceBandCount);
    vec2 sum = toComplex(texel.rg) + toComplex(texel.ba);
    float level = ncaLevelOf(0.5 * (texel.r + texel.b));
    float phase = atan(sum.y, sum.x);
    state0.xyz = vec3(level, level * cos(phase), level * sin(phase));
  }

  if (cell == ivec2(ncaGrid / 2)) {
    state0.w = 1.0;
    state1 = vec4(1.0);
    state2 = vec4(1.0);
  }

  outColor = state0;
  outState1 = state1;
  outState2 = state2;
}
