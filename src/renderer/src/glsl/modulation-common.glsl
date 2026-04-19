#include "../../lygia/generative/snoise.glsl"
#include "../../lygia/generative/random.glsl"

#define NUM_MODULATORS 3
// Using DataTexture for seq data (no uniform limit issues)
#define MAX_SEQ_STEPS_X 16
#define MAX_SEQ_STEPS_Y 16

struct Modulator {
  int modulatorMode;
  int modulatorPatternShape;
  int modulatorPhaseMode;
  Parameter modulatorPhaseX;
  Parameter modulatorPhaseY;
  Parameter modulatorPatternRateX;
  Parameter modulatorPatternRateY;
  Parameter modulatorStrength;
  Parameter modulatorRotation;
  float modulatorEnvelopeSmoothing; // UV half-width of the averaging window
  int modulatorEnvelopeSource; // 0=Amplitude, 1=Phase, 2=Panning
  float modulatorEnvelopeMinDb;
  float modulatorEnvelopeMaxDb;
  // Sequencer parameters
  int seqStepsX;
  int seqStepsY;
  Parameter seqLoopX;
  Parameter seqLoopY;
  Parameter seqSwing;
};

uniform Modulator[NUM_MODULATORS] modulators;
uniform sampler2D gainLut;
uniform sampler2D modulator1ImageTex;
uniform sampler2D modulator2ImageTex;
uniform sampler2D modulator3ImageTex;

// Sequencer data textures (values: 16x16)
uniform sampler2D modulator1SeqDataTex;
uniform sampler2D modulator2SeqDataTex;
uniform sampler2D modulator3SeqDataTex;

// Helper to get sequencer data value by modulator index (samples from texture)
float getSeqDataValue(int modulatorIndex, int stepX, int stepY) {
  // Convert step indices to texture UV coordinates (center of texel)
  float u = (float(stepX) + 0.5) / float(MAX_SEQ_STEPS_X);
  float v = (float(stepY) + 0.5) / float(MAX_SEQ_STEPS_Y);
  if (modulatorIndex == 0) return texture(modulator1SeqDataTex, vec2(u, v)).r;
  if (modulatorIndex == 1) return texture(modulator2SeqDataTex, vec2(u, v)).r;
  return texture(modulator3SeqDataTex, vec2(u, v)).r;
}

// Number of samples used when envelope smoothing is active.
#define NUM_ENVELOPE_SMOOTH_SAMPLES 8

// Returns the envelope value [0, 1] at a given UV for the specified source type.
// Falls back gracefully when spectrogram sampling is not available (e.g. preview shader).
float sampleEnvelopeAtUv(int src, vec2 sampleUv, float audioLevelDb, float minDb, float maxDb) {
  if (src == 1) { // Phase: normalize [-PI, PI] to [0, 1]
    #ifdef HAS_SPECTROGRAM_SAMPLING
      vec4 s = sampleSourceInterp(sampleUv);
      return (getPhase(s.rg) + PI) / (2.0 * PI);
    #else
      return 0.5;
    #endif
  } else if (src == 2) { // Panning: normalize [-1, 1] to [0, 1]
    #ifdef HAS_SPECTROGRAM_SAMPLING
      vec4 s = sampleSourceInterp(sampleUv);
      float mL = getMag(s.rg);
      float mR = getMag(s.ba);
      return (mR - mL) / max(mR + mL, EPSILON) * 0.5 + 0.5;
    #else
      return 0.5;
    #endif
  } else { // Amplitude: map [minDb, maxDb] to [0, 1]
    #ifdef HAS_SPECTROGRAM_SAMPLING
      vec4 s = sampleSourceInterp(sampleUv);
      float mL = getMag(s.rg);
      float mR = getMag(s.ba);
      float avgMag = max(0.5 * (mL + mR), 1e-6);
      float levelDb = 20.0 * log(avgMag) / log(10.0);
      return clamp((levelDb - minDb) / (maxDb - minDb), 0.0, 1.0);
    #else
      return clamp((audioLevelDb - minDb) / (maxDb - minDb), 0.0, 1.0);
    #endif
  }
}

// Base version that doesn't apply modulation to modulator parameters
// This is used internally to avoid recursion
float getModulationBase(vec2 uv, int modulatorIndex, float patternRateX, float patternRateY, float strength, float rotation, float phaseX, float phaseY, float seqLoopX, float seqLoopY, float seqSwing, float audioLevelDb) {
  float v = 0.0;

  Modulator modulator = modulators[modulatorIndex];

  // Handle envelope follower mode
  if (modulator.modulatorMode == 1) { // Envelope Follower mode
    int src = modulator.modulatorEnvelopeSource;
    float minDb = modulator.modulatorEnvelopeMinDb;
    float maxDb = modulator.modulatorEnvelopeMaxDb;
    float smoothing = modulator.modulatorEnvelopeSmoothing;
    if (smoothing > EPSILON) {
      float total = 0.0;
      for (int i = 0; i < NUM_ENVELOPE_SMOOTH_SAMPLES; i++) {
        float t = (float(i) + 0.5) / float(NUM_ENVELOPE_SMOOTH_SAMPLES);
        vec2 sampleUv = vec2(clamp(uv.x + (t - 0.5) * 2.0 * smoothing, 0.0, 1.0), uv.y);
        total += sampleEnvelopeAtUv(src, sampleUv, audioLevelDb, minDb, maxDb);
      }
      v = total / float(NUM_ENVELOPE_SMOOTH_SAMPLES);
    } else {
      v = sampleEnvelopeAtUv(src, uv, audioLevelDb, minDb, maxDb);
    }
    return mix(0.5 - strength / 2.0, 0.5 + strength / 2.0, v);
  }

  // Handle sequencer mode
  if (modulator.modulatorMode == 2) { // Sequencer mode
    // Apply phase mode: adjust UV based on canvas or brush space
    vec2 adjustedUv = uv;
    if (modulator.modulatorPhaseMode == 1) { // Brush mode
      adjustedUv = (uv - brushBottomLeftUv) / max(brushSizeUv, vec2(0.0001));
    }
    
    int stepsX = modulator.seqStepsX;
    int stepsY = modulator.seqStepsY;
    float loopX = seqLoopX;
    float loopY = seqLoopY;
    float swing = seqSwing;
    
    // Calculate horizontal position
    float posX = loopX > 0.0 ? mod(adjustedUv.x, loopX) / loopX : 0.0;
    int stepX = int(floor(posX * float(stepsX)));
    
    // Apply swing to odd steps
    float swingOffset = mod(float(stepX), 2.0) * swing * (1.0 / float(stepsX));
    posX = mod(posX + swingOffset, 1.0);
    stepX = int(floor(posX * float(stepsX)));
    stepX = clamp(stepX, 0, stepsX - 1);
    
    // Calculate vertical position
    float posY = loopY > 0.0 ? mod(adjustedUv.y, loopY) / loopY : 0.0;
    int stepY = int(floor(posY * float(stepsY)));
    stepY = clamp(stepY, 0, stepsY - 1);
    
    // Sample from data texture
    v = getSeqDataValue(modulatorIndex, stepX, stepY);
    
    return mix(0.5 - strength / 2.0, 0.5 + strength / 2.0, v);
  }

  // Pattern mode (mode 0) - continue with pattern generation
  // Apply phase mode: adjust UV based on canvas or brush space
  vec2 adjustedUv = uv;
  if (modulator.modulatorPhaseMode == 1) { // Brush mode
    // Convert to brush-relative coordinates (bottom-left is origin)
    adjustedUv = (uv - brushBottomLeftUv) / max(brushSizeUv, vec2(0.0001));
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
  
  // Apply phase offset
  pos += vec2(phaseX, phaseY);
  
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
  float phaseX = modulator.modulatorPhaseX.value;
  float phaseY = modulator.modulatorPhaseY.value;
  float seqLoopX = modulator.seqLoopX.value;
  float seqLoopY = modulator.seqLoopY.value;
  float seqSwing = modulator.seqSwing.value;
  
  // Only apply modulation to modulator parameters if we're at depth 0 (not nested)
  // This is disabled on Windows due to shader compilation performance issues
  #ifndef DISABLE_NESTED_MODULATION
  if (allowNestedModulation) {
    // Apply one level of modulation to each parameter
    for (int i = 0; i < NUM_MODULATORS; i++) {
      float modAmount = modulator.modulatorPatternRateX.modulationAmounts[i];
      if (modAmount != 0.0) {
        float mod = getModulationBase(uv, i, 
          modulators[i].modulatorPatternRateX.value,
          modulators[i].modulatorPatternRateY.value,
          modulators[i].modulatorStrength.value,
          modulators[i].modulatorRotation.value,
          modulators[i].modulatorPhaseX.value,
          modulators[i].modulatorPhaseY.value,
          modulators[i].seqLoopX.value,
          modulators[i].seqLoopY.value,
          modulators[i].seqSwing.value,
          audioLevelDb);
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
          modulators[i].modulatorRotation.value,
          modulators[i].modulatorPhaseX.value,
          modulators[i].modulatorPhaseY.value,
          modulators[i].seqLoopX.value,
          modulators[i].seqLoopY.value,
          modulators[i].seqSwing.value,
          audioLevelDb);
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
          modulators[i].modulatorRotation.value,
          modulators[i].modulatorPhaseX.value,
          modulators[i].modulatorPhaseY.value,
          modulators[i].seqLoopX.value,
          modulators[i].seqLoopY.value,
          modulators[i].seqSwing.value,
          audioLevelDb);
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
          modulators[i].modulatorRotation.value,
          modulators[i].modulatorPhaseX.value,
          modulators[i].modulatorPhaseY.value,
          modulators[i].seqLoopX.value,
          modulators[i].seqLoopY.value,
          modulators[i].seqSwing.value,
          audioLevelDb);
        float minV = modAmount < 0.0 ? modulator.modulatorRotation.maxValue : modulator.modulatorRotation.minValue;
        float maxV = modAmount < 0.0 ? modulator.modulatorRotation.minValue : modulator.modulatorRotation.maxValue;
        rotation = mix(rotation, mix(minV, maxV, mod), clamp(abs(modAmount), 0.0, 1.0));
      }
      modAmount = modulator.seqLoopX.modulationAmounts[i];
      if (modAmount != 0.0) {
        float mod = getModulationBase(uv, i,
          modulators[i].modulatorPatternRateX.value,
          modulators[i].modulatorPatternRateY.value,
          modulators[i].modulatorStrength.value,
          modulators[i].modulatorRotation.value,
          modulators[i].modulatorPhaseX.value,
          modulators[i].modulatorPhaseY.value,
          modulators[i].seqLoopX.value,
          modulators[i].seqLoopY.value,
          modulators[i].seqSwing.value,
          audioLevelDb);
        float minV = modAmount < 0.0 ? modulator.seqLoopX.maxValue : modulator.seqLoopX.minValue;
        float maxV = modAmount < 0.0 ? modulator.seqLoopX.minValue : modulator.seqLoopX.maxValue;
        seqLoopX = mix(seqLoopX, mix(minV, maxV, mod), clamp(abs(modAmount), 0.0, 1.0));
      }
      
      modAmount = modulator.seqLoopY.modulationAmounts[i];
      if (modAmount != 0.0) {
        float mod = getModulationBase(uv, i,
          modulators[i].modulatorPatternRateX.value,
          modulators[i].modulatorPatternRateY.value,
          modulators[i].modulatorStrength.value,
          modulators[i].modulatorRotation.value,
          modulators[i].modulatorPhaseX.value,
          modulators[i].modulatorPhaseY.value,
          modulators[i].seqLoopX.value,
          modulators[i].seqLoopY.value,
          modulators[i].seqSwing.value,
          audioLevelDb);
        float minV = modAmount < 0.0 ? modulator.seqLoopY.maxValue : modulator.seqLoopY.minValue;
        float maxV = modAmount < 0.0 ? modulator.seqLoopY.minValue : modulator.seqLoopY.maxValue;
        seqLoopY = mix(seqLoopY, mix(minV, maxV, mod), clamp(abs(modAmount), 0.0, 1.0));
      }
      
      modAmount = modulator.seqSwing.modulationAmounts[i];
      if (modAmount != 0.0) {
        float mod = getModulationBase(uv, i,
          modulators[i].modulatorPatternRateX.value,
          modulators[i].modulatorPatternRateY.value,
          modulators[i].modulatorStrength.value,
          modulators[i].modulatorRotation.value,
          modulators[i].modulatorPhaseX.value,
          modulators[i].modulatorPhaseY.value,
          modulators[i].seqLoopX.value,
          modulators[i].seqLoopY.value,
          modulators[i].seqSwing.value,
          audioLevelDb);
        float minV = modAmount < 0.0 ? modulator.seqSwing.maxValue : modulator.seqSwing.minValue;
        float maxV = modAmount < 0.0 ? modulator.seqSwing.minValue : modulator.seqSwing.maxValue;
        seqSwing = mix(seqSwing, mix(minV, maxV, mod), clamp(abs(modAmount), 0.0, 1.0));
      }
    }

    // Apply macro modulation to each modulator parameter.
    // Macros are global scalars (macroValues[m]), so no getModulationBase call.
    for (int m = 0; m < NUM_MACROS; m++) {
      float mod = macroValues[m];

      float macroAmount = modulator.modulatorPatternRateX.macroAmounts[m];
      if (macroAmount != 0.0) {
        float minV = macroAmount < 0.0 ? modulator.modulatorPatternRateX.maxValue : modulator.modulatorPatternRateX.minValue;
        float maxV = macroAmount < 0.0 ? modulator.modulatorPatternRateX.minValue : modulator.modulatorPatternRateX.maxValue;
        patternRateX = mix(patternRateX, mix(minV, maxV, mod), clamp(abs(macroAmount), 0.0, 1.0));
      }

      macroAmount = modulator.modulatorPatternRateY.macroAmounts[m];
      if (macroAmount != 0.0) {
        float minV = macroAmount < 0.0 ? modulator.modulatorPatternRateY.maxValue : modulator.modulatorPatternRateY.minValue;
        float maxV = macroAmount < 0.0 ? modulator.modulatorPatternRateY.minValue : modulator.modulatorPatternRateY.maxValue;
        patternRateY = mix(patternRateY, mix(minV, maxV, mod), clamp(abs(macroAmount), 0.0, 1.0));
      }

      macroAmount = modulator.modulatorStrength.macroAmounts[m];
      if (macroAmount != 0.0) {
        float minV = macroAmount < 0.0 ? modulator.modulatorStrength.maxValue : modulator.modulatorStrength.minValue;
        float maxV = macroAmount < 0.0 ? modulator.modulatorStrength.minValue : modulator.modulatorStrength.maxValue;
        strength = mix(strength, mix(minV, maxV, mod), clamp(abs(macroAmount), 0.0, 1.0));
      }

      macroAmount = modulator.modulatorRotation.macroAmounts[m];
      if (macroAmount != 0.0) {
        float minV = macroAmount < 0.0 ? modulator.modulatorRotation.maxValue : modulator.modulatorRotation.minValue;
        float maxV = macroAmount < 0.0 ? modulator.modulatorRotation.minValue : modulator.modulatorRotation.maxValue;
        rotation = mix(rotation, mix(minV, maxV, mod), clamp(abs(macroAmount), 0.0, 1.0));
      }

      macroAmount = modulator.modulatorPhaseX.macroAmounts[m];
      if (macroAmount != 0.0) {
        float minV = macroAmount < 0.0 ? modulator.modulatorPhaseX.maxValue : modulator.modulatorPhaseX.minValue;
        float maxV = macroAmount < 0.0 ? modulator.modulatorPhaseX.minValue : modulator.modulatorPhaseX.maxValue;
        phaseX = mix(phaseX, mix(minV, maxV, mod), clamp(abs(macroAmount), 0.0, 1.0));
      }

      macroAmount = modulator.modulatorPhaseY.macroAmounts[m];
      if (macroAmount != 0.0) {
        float minV = macroAmount < 0.0 ? modulator.modulatorPhaseY.maxValue : modulator.modulatorPhaseY.minValue;
        float maxV = macroAmount < 0.0 ? modulator.modulatorPhaseY.minValue : modulator.modulatorPhaseY.maxValue;
        phaseY = mix(phaseY, mix(minV, maxV, mod), clamp(abs(macroAmount), 0.0, 1.0));
      }

      macroAmount = modulator.seqLoopX.macroAmounts[m];
      if (macroAmount != 0.0) {
        float minV = macroAmount < 0.0 ? modulator.seqLoopX.maxValue : modulator.seqLoopX.minValue;
        float maxV = macroAmount < 0.0 ? modulator.seqLoopX.minValue : modulator.seqLoopX.maxValue;
        seqLoopX = mix(seqLoopX, mix(minV, maxV, mod), clamp(abs(macroAmount), 0.0, 1.0));
      }

      macroAmount = modulator.seqLoopY.macroAmounts[m];
      if (macroAmount != 0.0) {
        float minV = macroAmount < 0.0 ? modulator.seqLoopY.maxValue : modulator.seqLoopY.minValue;
        float maxV = macroAmount < 0.0 ? modulator.seqLoopY.minValue : modulator.seqLoopY.maxValue;
        seqLoopY = mix(seqLoopY, mix(minV, maxV, mod), clamp(abs(macroAmount), 0.0, 1.0));
      }

      macroAmount = modulator.seqSwing.macroAmounts[m];
      if (macroAmount != 0.0) {
        float minV = macroAmount < 0.0 ? modulator.seqSwing.maxValue : modulator.seqSwing.minValue;
        float maxV = macroAmount < 0.0 ? modulator.seqSwing.minValue : modulator.seqSwing.maxValue;
        seqSwing = mix(seqSwing, mix(minV, maxV, mod), clamp(abs(macroAmount), 0.0, 1.0));
      }
    }
  }
  #endif
  
  return getModulationBase(uv, modulatorIndex, patternRateX, patternRateY, strength, rotation, phaseX, phaseY, seqLoopX, seqLoopY, seqSwing, audioLevelDb);
}

float applyModulation(float value, float minValue, float maxValue, float[NUM_MODULATORS] modulationAmounts, float[NUM_CONTEXTUAL_MOD_SOURCES] contextualModAmounts, float[NUM_MACROS] macroAmounts, vec2 uv, int depth, float audioLevelDb) {
  float totalModulation = 0.0;
  float totalModulationAmount = 0.0;

  // depth 0 = brush parameters (allow nested modulation)
  // depth 1+ = modulator parameters (no nested modulation)
  bool allowNested = (depth == 0);

  // Apply pattern modulator sources
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

  // Apply contextual modulation sources
  // Order: iteration, time, pitch, random, step, pressure, tiltX, tiltY
  float contextualValues[NUM_CONTEXTUAL_MOD_SOURCES] = float[NUM_CONTEXTUAL_MOD_SOURCES](
    strokeIterationNormalized,
    strokeTimePosition,
    strokePitchPosition,
    strokeRandom,
    strokeStepNormalized,
    strokePressure,
    strokeTiltX,
    strokeTiltY
  );

  for (int i = 0; i < NUM_CONTEXTUAL_MOD_SOURCES; i++) {
    float modulationAmount = contextualModAmounts[i];
    if (modulationAmount == 0.0) {
      continue;
    }

    float modulation = contextualValues[i];  // Already 0-1

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

  // Apply macro modulation sources
  for (int i = 0; i < NUM_MACROS; i++) {
    float modulationAmount = macroAmounts[i];
    if (modulationAmount == 0.0) {
      continue;
    }

    float modulation = macroValues[i];  // Already 0-1

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