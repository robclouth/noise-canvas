#include "../../lygia/generative/snoise.glsl"
#include "../../lygia/generative/random.glsl"
#include "../../lygia/generative/fbm.glsl"
#include "../../lygia/generative/voronoi.glsl"
#include "../../lygia/generative/wavelet.glsl"
#include "../../lygia/generative/worley.glsl"

uniform int modulatorMode;
uniform int modulatorPatternShape;
uniform vec2 modulatorPatternRate;
uniform float modulatorStrength;
uniform float modulatorRotation;
uniform float modulatorKeyAmount;
uniform sampler2D gainLut;

float getModulation(vec2 uv) {
  float v = 0.0;

  vec2 rates = vec2(
    modulatorPatternRate.x == 0.0 ? 0.0 : 1.0 / modulatorPatternRate.x,
    modulatorPatternRate.y == 0.0 ? 0.0 : 1.0 / modulatorPatternRate.y
  );

  float rot = modulatorRotation * PI / 180.0;
  float s = sin(rot);
  float c = cos(rot);
  mat2 m = mat2(c, -s, s, c);
  vec2 rotatedUv = m * (uv - 0.5) + 0.5;

  vec2 pos = rotatedUv * rates;
  bool x_zero = modulatorPatternRate.x == 0.0;
  bool y_zero = modulatorPatternRate.y == 0.0;

  if (modulatorPatternShape == 0) { // SINE
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
  } else if (modulatorPatternShape == 1) { // TRIANGLE
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
  } else if (modulatorPatternShape == 2) { // SQUARE
    vec2 p = fract(pos);
    v = pow(step(0.5, p.x) - step(0.5, p.y), 2.0);
  } else if (modulatorPatternShape == 3) { // SAWTOOTH
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
  } else if (modulatorPatternShape == 4) { // PULSE
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
  } else if (modulatorPatternShape == 5) { // RANDOM
    v = random(floor(pos)) ;
  } else if (modulatorPatternShape == 6) { // SNOISE
    v = snoise(pos) * 0.5 + 0.5;
  } else if (modulatorPatternShape == 7) { // FBM
    v = fbm(pos) * 0.5 + 0.5;
  } else if (modulatorPatternShape == 8) { // VORONOI
    v = voronoi(pos).x;
  } else if (modulatorPatternShape == 9) { // WAVELET
    v = wavelet(pos) * 0.5 + 0.5;
  } else if (modulatorPatternShape == 10) { // WORLEY
    v = worley(pos);
  } else if (modulatorPatternShape == 11) { // SCALE
    v = texture2D(gainLut, vec2(rotatedUv.y, 0.5)).r;
  }

  return mix(0.5 - modulatorStrength / 2.0, 0.5 + modulatorStrength / 2.0, v);
}

float applyModulation(float value, float minValue, float maxValue, float modulationAmount, vec2 uv) {
  if (modulationAmount == 0.0) {
    return value;
  }

  float modulation = getModulation(uv);

  float minV = minValue;
  float maxV = maxValue;

  if (modulationAmount < 0.0) {
    minV = maxValue;
    maxV = minValue;
  }

  float modulatedValue = mix(minV, maxV, modulation);

  return mix(value, modulatedValue, abs(modulationAmount));
}