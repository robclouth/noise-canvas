#include "../../lygia/generative/snoise.glsl"
#include "../../lygia/generative/random.glsl"

#define NUM_MODULATORS 3

struct Modulator {
  int modulatorMode;
  int modulatorPatternShape;
  int modulatorPhaseMode;
  Parameter modulatorPatternRateX;
  Parameter modulatorPatternRateY;
  Parameter modulatorStrength;
  Parameter modulatorRotation;
  float modulatorEnvelopeMinDb;
  float modulatorEnvelopeMaxDb;
};

uniform Modulator[NUM_MODULATORS] modulators;
uniform sampler2D gainLut;
uniform sampler2D modulator1ImageTex;
uniform sampler2D modulator2ImageTex;
uniform sampler2D modulator3ImageTex;

// Base version that doesn't apply modulation to modulator parameters
// This is used internally to avoid recursion
float getModulationBase(vec2 uv, int modulatorIndex, float patternRateX, float patternRateY, float strength, float rotation, float audioLevelDb) {
  float v = 0.0;

  Modulator modulator = modulators[modulatorIndex];

  // Handle envelope follower mode
  if (modulator.modulatorMode == 1) { // Envelope Follower mode
    // Map audio level from [minDb, maxDb] to [0, 1]
    float minDb = modulator.modulatorEnvelopeMinDb;
    float maxDb = modulator.modulatorEnvelopeMaxDb;
    v = clamp((audioLevelDb - minDb) / (maxDb - minDb), 0.0, 1.0);
    return mix(0.5 - strength / 2.0, 0.5 + strength / 2.0, v);
  }

  // Pattern mode (mode 0) - continue with pattern generation
  // Apply phase mode: adjust UV based on canvas or brush space
  vec2 adjustedUv = uv;
  if (modulator.modulatorPhaseMode == 1) { // Brush mode
    // Convert to brush-relative coordinates (centered at brush center)
    adjustedUv = (uv - brushCenterUv) / max(brushSizeUv, vec2(0.0001)) + 0.5;
  }

  vec2 rates = vec2(
    patternRateX == 0.0 ? 0.0 : 1.0 / patternRateX,
    patternRateY == 0.0 ? 0.0 : 1.0 / patternRateY
  );

  float rot = rotation * PI / 180.0;
  float s = sin(rot);
  float c = cos(rot);
  mat2 m = mat2(c, -s, s, c);
  vec2 rotatedUv = m * (adjustedUv - 0.5) + 0.5;

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
  } else if (modulator.modulatorPatternShape == 12) { // IMAGE
    // Sample from the appropriate image texture based on modulator index
    // Use rate-scaled position for tiling control
    if (modulatorIndex == 0) {
      v = texture(modulator1ImageTex, pos).r;
    } else if (modulatorIndex == 1) {
      v = texture(modulator2ImageTex, pos).r;
    } else if (modulatorIndex == 2) {
      v = texture(modulator3ImageTex, pos).r;
    }
  }

  return mix(0.5 - strength / 2.0, 0.5 + strength / 2.0, v);
}

float getModulation(vec2 uv, int modulatorIndex, bool allowNestedModulation, float audioLevelDb) {
  Modulator modulator = modulators[modulatorIndex];
  
  float patternRateX = modulator.modulatorPatternRateX.value;
  float patternRateY = modulator.modulatorPatternRateY.value;
  float strength = modulator.modulatorStrength.value;
  float rotation = modulator.modulatorRotation.value;
  
  return getModulationBase(uv, modulatorIndex, patternRateX, patternRateY, strength, rotation, audioLevelDb);
}

float applyModulation(float value, float minValue, float maxValue, float[NUM_MODULATORS] modulationAmounts, vec2 uv, int depth, float audioLevelDb) {
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

    float modulation = getModulation(uv, i, allowNested, audioLevelDb);

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