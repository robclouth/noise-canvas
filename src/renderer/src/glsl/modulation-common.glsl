#include "../../lygia/generative/snoise.glsl"
#include "../../lygia/generative/random.glsl"
#include "../../lygia/generative/fbm.glsl"
#include "../../lygia/generative/voronoi.glsl"
#include "../../lygia/generative/wavelet.glsl"
#include "../../lygia/generative/worley.glsl"

#define NUM_MODULATORS 3

struct Modulator {
  int modulatorMode;
  int modulatorPatternShape;
  float modulatorPatternRateX;
  float modulatorPatternRateY;
  float modulatorStrength;
  float modulatorRotation;
};

uniform Modulator[NUM_MODULATORS] modulators;
uniform sampler2D gainLut;

float getModulation(vec2 uv, int modulatorIndex) {
  float v = 0.0;

  Modulator modulator = modulators[modulatorIndex];

  vec2 rates = vec2(
    modulator.modulatorPatternRateX == 0.0 ? 0.0 : 1.0 / modulator.modulatorPatternRateX,
    modulator.modulatorPatternRateY == 0.0 ? 0.0 : 1.0 / modulator.modulatorPatternRateY
  );

  float rot = modulator.modulatorRotation * PI / 180.0;
  float s = sin(rot);
  float c = cos(rot);
  mat2 m = mat2(c, -s, s, c);
  vec2 rotatedUv = m * (uv - 0.5) + 0.5;

  vec2 pos = rotatedUv * rates;
  bool x_zero = modulator.modulatorPatternRateX == 0.0;
  bool y_zero = modulator.modulatorPatternRateY == 0.0;

  if (modulator.modulatorPatternShape == 0) { // SINE
    float sx = sin(pos.x * 2.0 * PI);
    float sy = sin(pos.y * 2.0 * PI);
    if (x_zero && y_zero) {
      v = 0.5;
    } else if (x_zero) {
      v = sy * 0.5 + 0.5;
    } else if (y_zero) {
      v = sx * 0.5 + 0.5;
    } else {
      v = (sx + sy) / 4.0 + 0.5;
    }
  } else if (modulator.modulatorPatternShape == 1) { // TRIANGLE
    vec2 p = fract(pos);
    float tx = 1.0 - abs(p.x * 2.0 - 1.0);
    float ty = 1.0 - abs(p.y * 2.0 - 1.0);
    if (x_zero && y_zero) {
      v = 1.0;
    } else if (x_zero) {
      v = ty;
    } else if (y_zero) {
      v = tx;
    } else {
      v = tx * ty;
    }
  } else if (modulator.modulatorPatternShape == 2) { // SQUARE
    vec2 p = fract(pos);
    v = pow(step(0.5, p.x) - step(0.5, p.y), 2.0);
  } else if (modulator.modulatorPatternShape == 3) { // SAWTOOTH
    vec2 p = fract(pos);
    if (x_zero && y_zero) {
      v = 0.0;
    } else if (x_zero) {
      v = p.y;
    } else if (y_zero) {
      v = p.x;
    } else {
      v = p.x * p.y;
    }
  } else if (modulator.modulatorPatternShape == 4) { // PULSE
    vec2 p = fract(pos);
    if (x_zero && y_zero) {
      v = 1.0;
    } else if (x_zero) {
      v = 1.0 - step(0.2, p.y);
    } else if (y_zero) {
      v = 1.0 - step(0.2, p.x);
    } else {
      v = max(1.0 - step(0.2, p.x), 1.0 - step(0.2, p.y));
    }
  } else if (modulator.modulatorPatternShape == 5) { // RANDOM
    v = random(floor(pos)) ;
  } else if (modulator.modulatorPatternShape == 6) { // SNOISE
    v = snoise(pos) * 0.5 + 0.5;
  } else if (modulator.modulatorPatternShape == 7) { // FBM
    v = fbm(pos) * 0.5 + 0.5;
  } else if (modulator.modulatorPatternShape == 8) { // VORONOI
    v = voronoi(pos).x;
  } else if (modulator.modulatorPatternShape == 9) { // WAVELET
    v = wavelet(pos) * 0.5 + 0.5;
  } else if (modulator.modulatorPatternShape == 10) { // WORLEY
    v = worley(pos);
  } else if (modulator.modulatorPatternShape == 11) { // SCALE
    v = texture2D(gainLut, vec2(rotatedUv.y, 0.5)).r;
  }

  return mix(0.5 - modulator.modulatorStrength / 2.0, 0.5 + modulator.modulatorStrength / 2.0, v);
}

float applyModulation(float value, float minValue, float maxValue, float[NUM_MODULATORS] modulationAmounts, vec2 uv) {
  float totalModulation = 0.0;
  float totalModulationAmount = 0.0;

  for (int i = 0; i < NUM_MODULATORS; i++) {
    float modulationAmount = modulationAmounts[i];
    if (modulationAmount == 0.0) {
      continue;
    }

    float modulation = getModulation(uv, i);

    float minV = minValue;
    float maxV = maxValue;

    if (modulationAmount < 0.0) {
      minV = maxValue;
      maxV = minValue;
    }

    float modulatedValue = mix(minV, maxV, modulation);

    totalModulation += modulatedValue * modulationAmount;
    totalModulationAmount += abs(modulationAmount);
  }

  if (totalModulationAmount == 0.0) {
    return value;
  }

  float modulatedValue = totalModulation / totalModulationAmount;

  return mix(value, modulatedValue, clamp(totalModulationAmount, 0.0, 1.0));
}