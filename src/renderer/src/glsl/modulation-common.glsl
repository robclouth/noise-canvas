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
  Parameter modulatorPatternRateX;
  Parameter modulatorPatternRateY;
  Parameter modulatorStrength;
  Parameter modulatorRotation;
};

uniform Modulator[NUM_MODULATORS] modulators;
uniform sampler2D gainLut;
uniform sampler2D modulator1ImageTex;
uniform sampler2D modulator2ImageTex;
uniform sampler2D modulator3ImageTex;

// Base version that doesn't apply modulation to modulator parameters
// This is used internally to avoid recursion
float getModulationBase(vec2 uv, int modulatorIndex, float patternRateX, float patternRateY, float strength, float rotation) {
  float v = 0.0;

  Modulator modulator = modulators[modulatorIndex];

  vec2 rates = vec2(
    patternRateX == 0.0 ? 0.0 : 1.0 / patternRateX,
    patternRateY == 0.0 ? 0.0 : 1.0 / patternRateY
  );

  float rot = rotation * PI / 180.0;
  float s = sin(rot);
  float c = cos(rot);
  mat2 m = mat2(c, -s, s, c);
  vec2 rotatedUv = m * (uv - 0.5) + 0.5;

  vec2 pos = rotatedUv * rates;
  bool x_zero = patternRateX == 0.0;
  bool y_zero = patternRateY == 0.0;

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
  } else if (modulator.modulatorPatternShape == 12) { // IMAGE
    // Sample from the appropriate image texture based on modulator index
    // Use rate-scaled position for tiling control
    if (modulatorIndex == 0) {
      v = texture2D(modulator1ImageTex, pos).r;
    } else if (modulatorIndex == 1) {
      v = texture2D(modulator2ImageTex, pos).r;
    } else if (modulatorIndex == 2) {
      v = texture2D(modulator3ImageTex, pos).r;
    }
  }

  return mix(0.5 - strength / 2.0, 0.5 + strength / 2.0, v);
}

// Version with modulated parameters (calls base version with computed params)
float getModulation(vec2 uv, int modulatorIndex, bool allowNestedModulation) {
  Modulator modulator = modulators[modulatorIndex];
  
  float patternRateX = modulator.modulatorPatternRateX.value;
  float patternRateY = modulator.modulatorPatternRateY.value;
  float strength = modulator.modulatorStrength.value;
  float rotation = modulator.modulatorRotation.value;
  
  // Only apply modulation to modulator parameters if we're at depth 0 (not nested)
  if (allowNestedModulation) {
    // Apply one level of modulation to each parameter
    for (int i = 0; i < NUM_MODULATORS; i++) {
      float modAmount = modulator.modulatorPatternRateX.modulationAmounts[i];
      if (modAmount != 0.0) {
        float mod = getModulationBase(uv, i, 
          modulators[i].modulatorPatternRateX.value,
          modulators[i].modulatorPatternRateY.value,
          modulators[i].modulatorStrength.value,
          modulators[i].modulatorRotation.value);
        float minV = modAmount < 0.0 ? modulator.modulatorPatternRateX.maxValue : modulator.modulatorPatternRateX.minValue;
        float maxV = modAmount < 0.0 ? modulator.modulatorPatternRateX.minValue : modulator.modulatorPatternRateX.maxValue;
        patternRateX = mix(patternRateX, mix(minV, maxV, mod), clamp(abs(modAmount), 0.0, 1.0));
      }
      
      modAmount = modulator.modulatorPatternRateY.modulationAmounts[i];
      if (modAmount != 0.0) {
        float mod = getModulationBase(uv, i,
          modulators[i].modulatorPatternRateX.value,
          modulators[i].modulatorPatternRateY.value,
          modulators[i].modulatorStrength.value,
          modulators[i].modulatorRotation.value);
        float minV = modAmount < 0.0 ? modulator.modulatorPatternRateY.maxValue : modulator.modulatorPatternRateY.minValue;
        float maxV = modAmount < 0.0 ? modulator.modulatorPatternRateY.minValue : modulator.modulatorPatternRateY.maxValue;
        patternRateY = mix(patternRateY, mix(minV, maxV, mod), clamp(abs(modAmount), 0.0, 1.0));
      }
      
      modAmount = modulator.modulatorStrength.modulationAmounts[i];
      if (modAmount != 0.0) {
        float mod = getModulationBase(uv, i,
          modulators[i].modulatorPatternRateX.value,
          modulators[i].modulatorPatternRateY.value,
          modulators[i].modulatorStrength.value,
          modulators[i].modulatorRotation.value);
        float minV = modAmount < 0.0 ? modulator.modulatorStrength.maxValue : modulator.modulatorStrength.minValue;
        float maxV = modAmount < 0.0 ? modulator.modulatorStrength.minValue : modulator.modulatorStrength.maxValue;
        strength = mix(strength, mix(minV, maxV, mod), clamp(abs(modAmount), 0.0, 1.0));
      }
      
      modAmount = modulator.modulatorRotation.modulationAmounts[i];
      if (modAmount != 0.0) {
        float mod = getModulationBase(uv, i,
          modulators[i].modulatorPatternRateX.value,
          modulators[i].modulatorPatternRateY.value,
          modulators[i].modulatorStrength.value,
          modulators[i].modulatorRotation.value);
        float minV = modAmount < 0.0 ? modulator.modulatorRotation.maxValue : modulator.modulatorRotation.minValue;
        float maxV = modAmount < 0.0 ? modulator.modulatorRotation.minValue : modulator.modulatorRotation.maxValue;
        rotation = mix(rotation, mix(minV, maxV, mod), clamp(abs(modAmount), 0.0, 1.0));
      }
    }
  }
  
  return getModulationBase(uv, modulatorIndex, patternRateX, patternRateY, strength, rotation);
}

float applyModulation(float value, float minValue, float maxValue, float[NUM_MODULATORS] modulationAmounts, vec2 uv, int depth) {
  float totalModulation = 0.0;
  float totalModulationAmount = 0.0;

  // depth 0 = brush parameters (allow nested modulation)
  // depth 1+ = modulator parameters (no nested modulation)
  bool allowNested = (depth == 0);

  for (int i = 0; i < NUM_MODULATORS; i++) {
    float modulationAmount = modulationAmounts[i];
    if (modulationAmount == 0.0) {
      continue;
    }

    float modulation = getModulation(uv, i, allowNested);

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