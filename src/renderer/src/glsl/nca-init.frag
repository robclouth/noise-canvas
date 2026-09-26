#include "effect-common.glsl"

// Fills the automaton's grid from the sound under the brush: each cell hears
// the source at its place in the brush, with no hidden state, and the seed
// (every hidden channel on, no sound) planted in the middle cell. The level is
// the mean of the two channels; the phase is the left channel's unwrapped path
// from the row's first cell, and how far it moved over the last cell. Mirrors
// readGrid and soundState in lib/nca, which build the same state for training.

layout(location = 1) out vec4 outState1;
layout(location = 2) out vec4 outState2;

uniform int ncaGrid;

const float NCA_DB_RANGE = 90.0;
const float NCA_PATH_SCALE = 32.0;
const float NCA_RATE_SCALE = 8.0;

float ncaLevelOf(float magnitude) {
  float db = 20.0 * log(max(magnitude, 1e-12)) / log(10.0);
  return max(1.0 + db / NCA_DB_RANGE, 0.0);
}

// The source coefficients at a column of this cell's row.
vec4 sourceAt(int col, float rowLocal) {
  vec2 local = vec2((float(col) + 0.5) / float(ncaGrid), rowLocal);
  vec2 sourceUv = destUvToSourceUv(brushBottomLeftUv + local * brushSizeUv);
  return readPackedData(vec2(fract(sourceUv.x), sourceUv.y), sourceSpectrogramTex, sourceMetadataTex, sourceFrameCount, sourceBandCount);
}

void main() {
  ivec2 cell = ivec2(floor(vUv * float(ncaGrid)));
  float rowLocal = (float(cell.y) + 0.5) / float(ncaGrid);
  vec2 sourceUv = destUvToSourceUv(brushBottomLeftUv + vec2(0.0, rowLocal) * brushSizeUv);

  vec4 state0 = vec4(0.0);
  vec4 state1 = vec4(0.0);
  vec4 state2 = vec4(0.0);
  if (sourceUv.y >= 0.0 && sourceUv.y < 1.0) {
    vec4 texel = sourceAt(cell.x, rowLocal);
    float first = sourceAt(0, rowLocal).g;
    float previous = cell.x > 0 ? sourceAt(cell.x - 1, rowLocal).g : texel.g;
    state0.xyz = vec3(ncaLevelOf(0.5 * (texel.r + texel.b)), (texel.g - first) / NCA_PATH_SCALE, (texel.g - previous) / NCA_RATE_SCALE);
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
