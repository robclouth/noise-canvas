precision highp float;
precision highp sampler2D;
precision highp int;

// One step of the neural cellular automaton (lib/nca/nca-model.ts). The state
// is 12 channels over three RGBA targets; the weights sit in a float texture,
// four to a texel, laid out as packWeightsForTexture writes them.

in vec2 vUv;
layout(location = 0) out vec4 outState0;
layout(location = 1) out vec4 outState1;
layout(location = 2) out vec4 outState2;

uniform sampler2D ncaState0;
uniform sampler2D ncaState1;
uniform sampler2D ncaState2;
uniform sampler2D ncaWeights;
uniform int ncaGrid;
uniform bool ncaFireAll;
uniform float ncaStepSeed;

#define NCA_CHANNELS 12
#define NCA_HIDDEN_TEXELS 16 // 64 hidden units, four to a texel
#define W1_TEXEL 0
#define POSITION_ROW 36       // perception rows 36 and 37: place along time, then pitch
#define B1_TEXEL 608          // 38 × 64 / 4
#define W2_TEXEL 624          // B1_TEXEL + 64 / 4
#define B2_TEXEL 816          // W2_TEXEL + 64 × 12 / 4
#define WEIGHT_TEXTURE_WIDTH 256
#define FIRE_RATE 0.5

vec4 weightTexel(int index) {
  return texelFetch(ncaWeights, ivec2(index % WEIGHT_TEXTURE_WIDTH, index / WEIGHT_TEXTURE_WIDTH), 0);
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  ivec2 cell = ivec2(floor(vUv * float(ncaGrid)));

  // Identity, Sobel along time (x) and Sobel along pitch (y) of each channel,
  // with zeros past the grid.
  vec4 identity[3];
  vec4 sobelX[3];
  vec4 sobelY[3];
  for (int k = 0; k < 3; k++) {
    identity[k] = vec4(0.0);
    sobelX[k] = vec4(0.0);
    sobelY[k] = vec4(0.0);
  }
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 at = cell + ivec2(dx, dy);
      if (at.x < 0 || at.y < 0 || at.x >= ncaGrid || at.y >= ncaGrid) continue;
      vec4 s0 = texelFetch(ncaState0, at, 0);
      vec4 s1 = texelFetch(ncaState1, at, 0);
      vec4 s2 = texelFetch(ncaState2, at, 0);
      float wx = float(dx) * (2.0 - abs(float(dy))) / 8.0;
      float wy = float(dy) * (2.0 - abs(float(dx))) / 8.0;
      sobelX[0] += s0 * wx; sobelX[1] += s1 * wx; sobelX[2] += s2 * wx;
      sobelY[0] += s0 * wy; sobelY[1] += s1 * wy; sobelY[2] += s2 * wy;
      if (dx == 0 && dy == 0) {
        identity[0] = s0; identity[1] = s1; identity[2] = s2;
      }
    }
  }

  // Hidden layer: perception index c·3 + view, then the cell's place; 64
  // units four to a texel.
  vec4 hidden[NCA_HIDDEN_TEXELS];
  for (int q = 0; q < NCA_HIDDEN_TEXELS; q++) hidden[q] = weightTexel(B1_TEXEL + q);
  for (int c = 0; c < NCA_CHANNELS; c++) {
    int k = c / 4;
    int component = c - k * 4;
    float views[3];
    views[0] = identity[k][component];
    views[1] = sobelX[k][component];
    views[2] = sobelY[k][component];
    for (int view = 0; view < 3; view++) {
      float p = views[view];
      if (p == 0.0) continue;
      int row = (c * 3 + view) * NCA_HIDDEN_TEXELS;
      for (int q = 0; q < NCA_HIDDEN_TEXELS; q++) hidden[q] += p * weightTexel(W1_TEXEL + row + q);
    }
  }

  vec2 place = (vec2(cell) + 0.5) / float(ncaGrid) * 2.0 - 1.0;
  for (int q = 0; q < NCA_HIDDEN_TEXELS; q++) {
    hidden[q] += place.x * weightTexel(W1_TEXEL + POSITION_ROW * NCA_HIDDEN_TEXELS + q);
    hidden[q] += place.y * weightTexel(W1_TEXEL + (POSITION_ROW + 1) * NCA_HIDDEN_TEXELS + q);
  }

  // Output layer: twelve channel updates from the rectified hidden units.
  vec4 update[3];
  for (int k = 0; k < 3; k++) update[k] = weightTexel(B2_TEXEL + k);
  for (int q = 0; q < NCA_HIDDEN_TEXELS; q++) {
    vec4 h = max(hidden[q], vec4(0.0));
    for (int j = 0; j < 4; j++) {
      float value = h[j];
      if (value == 0.0) continue;
      int unit = q * 4 + j;
      for (int k = 0; k < 3; k++) update[k] += value * weightTexel(W2_TEXEL + unit * 3 + k);
    }
  }

  float fire = (ncaFireAll || hash(vec2(cell) + ncaStepSeed * 17.31) < FIRE_RATE) ? 1.0 : 0.0;
  outState0 = identity[0] + update[0] * fire;
  outState1 = identity[1] + update[1] * fire;
  outState2 = identity[2] + update[2] * fire;
}
