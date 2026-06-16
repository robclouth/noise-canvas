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
  Parameter modulatorStereoSpread; // UV-space offset applied as ±spread/2 along time (x) axis
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

// Per-pixel precomputed modulator outputs, rendered once per step by the
// modulator pass. tex0 = (mod0.L, mod0.R, mod1.L, mod1.R); tex1 = (mod2.L,
// mod2.R, _, _). Effect shaders sample these instead of evaluating the
// modulators inline -- the expensive evaluator then compiles only into the
// modulator pass, not into every effect.
uniform sampler2D modulatorTex0;
uniform sampler2D modulatorTex1;

// Reads the precomputed stereo output of every modulator at this fragment.
void sampleModulators(out vec2 mods[NUM_MODULATORS]) {
  vec4 a = texture(modulatorTex0, vUv);
  vec4 b = texture(modulatorTex1, vUv);
  mods[0] = a.xy;
  mods[1] = a.zw;
  mods[2] = b.xy;
}

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

// Scalar evaluator used by both the stereo wrapper and by nested modulation.
// Nested paths always pass the base uv unmodified — stereo spread is applied
// only at the outermost evaluation via getModulationBase.
float evalModulatorAtUv(vec2 uv, int modulatorIndex, float patternRateX, float patternRateY, float strength, float rotation, float phaseX, float phaseY, float seqLoopX, float seqLoopY, float seqSwing, float audioLevelDb) {
#ifdef ABLATE_PATTERN_EVAL
  return 0.5;
#endif
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

// Stereo-aware wrapper. Offsets the sample UV by ±stereoSpread/2 along the
// time (x) axis and returns vec2(L, R). When spread is zero the single-sample
// fast path runs at mono cost.
vec2 getModulationBase(vec2 uv, int modulatorIndex, float patternRateX, float patternRateY, float strength, float rotation, float phaseX, float phaseY, float seqLoopX, float seqLoopY, float seqSwing, float stereoSpread, float audioLevelDb) {
  if (abs(stereoSpread) < EPSILON) {
    float v = evalModulatorAtUv(uv, modulatorIndex, patternRateX, patternRateY, strength, rotation, phaseX, phaseY, seqLoopX, seqLoopY, seqSwing, audioLevelDb);
    return vec2(v);
  }
  vec2 uvL = uv + vec2(-stereoSpread * 0.5, 0.0);
  vec2 uvR = uv + vec2(+stereoSpread * 0.5, 0.0);
  float vL = evalModulatorAtUv(uvL, modulatorIndex, patternRateX, patternRateY, strength, rotation, phaseX, phaseY, seqLoopX, seqLoopY, seqSwing, audioLevelDb);
  float vR = evalModulatorAtUv(uvR, modulatorIndex, patternRateX, patternRateY, strength, rotation, phaseX, phaseY, seqLoopX, seqLoopY, seqSwing, audioLevelDb);
  return vec2(vL, vR);
}

// Blends one nested pattern-modulator contribution into a modulator parameter.
// modScalar is the source modulator's evaluated output, shared across every
// parameter for a given source index so it is evaluated once and reused.
float applyNestedParam(float current, Parameter p, float modScalar, int i) {
  float a = p.modulationAmounts[i];
  if (a == 0.0) return current;
  float minV = a < 0.0 ? p.maxValue : p.minValue;
  float maxV = a < 0.0 ? p.minValue : p.maxValue;
  return mix(current, mix(minV, maxV, modScalar), clamp(abs(a), 0.0, 1.0));
}

// Blends one macro contribution into a modulator parameter. Macros are global
// scalars (macroValues[m]) broadcast identically to both stereo lanes.
float applyNestedMacro(float current, Parameter p, float macroVal, int m) {
  float a = p.macroAmounts[m];
  if (a == 0.0) return current;
  float minV = a < 0.0 ? p.maxValue : p.minValue;
  float maxV = a < 0.0 ? p.minValue : p.maxValue;
  return mix(current, mix(minV, maxV, macroVal), clamp(abs(a), 0.0, 1.0));
}

vec2 getModulation(vec2 uv, int modulatorIndex, bool allowNestedModulation, float audioLevelDb) {
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
  float stereoSpread = modulator.modulatorStereoSpread.value;
  
  // Only apply modulation to modulator parameters if we're at depth 0 (not nested)
  // This is disabled on Windows due to shader compilation performance issues
  #ifndef DISABLE_NESTED_MODULATION
  if (allowNestedModulation) {
    // Apply one level of pattern modulation to each modulator parameter. For a
    // given source modulator i every parameter shares the same evaluated output,
    // so it is computed once per i and reused across all parameters.
    for (int i = 0; i < NUM_MODULATORS; i++) {
      float modI = evalModulatorAtUv(uv, i,
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

      patternRateX = applyNestedParam(patternRateX, modulator.modulatorPatternRateX, modI, i);
      patternRateY = applyNestedParam(patternRateY, modulator.modulatorPatternRateY, modI, i);
      strength = applyNestedParam(strength, modulator.modulatorStrength, modI, i);
      rotation = applyNestedParam(rotation, modulator.modulatorRotation, modI, i);
      seqLoopX = applyNestedParam(seqLoopX, modulator.seqLoopX, modI, i);
      seqLoopY = applyNestedParam(seqLoopY, modulator.seqLoopY, modI, i);
      seqSwing = applyNestedParam(seqSwing, modulator.seqSwing, modI, i);
      stereoSpread = applyNestedParam(stereoSpread, modulator.modulatorStereoSpread, modI, i);
    }

    // Apply macro modulation to each modulator parameter. Unlike the pattern
    // loop above, macros also modulate phaseX/phaseY.
    for (int m = 0; m < NUM_MACROS; m++) {
      float macroVal = macroValues[m];
      patternRateX = applyNestedMacro(patternRateX, modulator.modulatorPatternRateX, macroVal, m);
      patternRateY = applyNestedMacro(patternRateY, modulator.modulatorPatternRateY, macroVal, m);
      strength = applyNestedMacro(strength, modulator.modulatorStrength, macroVal, m);
      rotation = applyNestedMacro(rotation, modulator.modulatorRotation, macroVal, m);
      phaseX = applyNestedMacro(phaseX, modulator.modulatorPhaseX, macroVal, m);
      phaseY = applyNestedMacro(phaseY, modulator.modulatorPhaseY, macroVal, m);
      seqLoopX = applyNestedMacro(seqLoopX, modulator.seqLoopX, macroVal, m);
      seqLoopY = applyNestedMacro(seqLoopY, modulator.seqLoopY, macroVal, m);
      seqSwing = applyNestedMacro(seqSwing, modulator.seqSwing, macroVal, m);
      stereoSpread = applyNestedMacro(stereoSpread, modulator.modulatorStereoSpread, macroVal, m);
    }
  }
  #endif

  return getModulationBase(uv, modulatorIndex, patternRateX, patternRateY, strength, rotation, phaseX, phaseY, seqLoopX, seqLoopY, seqSwing, stereoSpread, audioLevelDb);
}

// Blends precomputed modulator outputs, contextual sources and macros into a
// parameter. Identical to applyModulation but takes the modulator outputs from
// evalModulators instead of evaluating them here.
vec2 applyModulationCached(float value, float minValue, float maxValue, float[NUM_MODULATORS] modulationAmounts, float[NUM_CONTEXTUAL_MOD_SOURCES] contextualModAmounts, float[NUM_MACROS] macroAmounts, vec2 mods[NUM_MODULATORS]) {
#ifdef ABLATE_MODULATION
  return vec2(value);
#endif
  vec2 totalModulation = vec2(0.0);
  float totalModulationAmount = 0.0;

  for (int i = 0; i < NUM_MODULATORS; i++) {
    float modulationAmount = modulationAmounts[i];
    if (modulationAmount == 0.0) {
      continue;
    }

    vec2 modulation = mods[i];

    float minV = minValue;
    float maxV = maxValue;

    if (modulationAmount < 0.0) {
      minV = maxValue;
      maxV = minValue;
    }

    vec2 modulatedValue = mix(vec2(minV), vec2(maxV), modulation);

    totalModulation += modulatedValue * modulationAmount;
    totalModulationAmount += abs(modulationAmount);
  }

  // Apply contextual modulation sources — scalar, broadcast to both lanes.
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

    totalModulation += vec2(modulatedValue * modulationAmount);
    totalModulationAmount += abs(modulationAmount);
  }

  // Apply macro modulation sources — scalar, broadcast to both lanes.
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

    totalModulation += vec2(modulatedValue * modulationAmount);
    totalModulationAmount += abs(modulationAmount);
  }

  if (totalModulationAmount == 0.0) {
    return vec2(value);
  }

  vec2 modulatedValue = totalModulation / totalModulationAmount;

  return mix(vec2(value), modulatedValue, clamp(totalModulationAmount, 0.0, 1.0));
}

// Stereo modulation entry point. Evaluates the modulators at this uv then blends.
vec2 applyModulation(float value, float minValue, float maxValue, float[NUM_MODULATORS] modulationAmounts, float[NUM_CONTEXTUAL_MOD_SOURCES] contextualModAmounts, float[NUM_MACROS] macroAmounts, vec2 uv, int depth, float audioLevelDb) {
#ifdef ABLATE_MODULATION
  return vec2(value);
#endif
  vec2 mods[NUM_MODULATORS];
  sampleModulators(mods);
  return applyModulationCached(value, minValue, maxValue, modulationAmounts, contextualModAmounts, macroAmounts, mods);
}

// Mono helper for callsites where only a single scalar is needed (geometric /
// brush-envelope shape values that have no natural per-channel meaning).
float applyModulationMono(float value, float minValue, float maxValue, float[NUM_MODULATORS] modulationAmounts, float[NUM_CONTEXTUAL_MOD_SOURCES] contextualModAmounts, float[NUM_MACROS] macroAmounts, vec2 uv, int depth, float audioLevelDb) {
  return applyModulation(value, minValue, maxValue, modulationAmounts, contextualModAmounts, macroAmounts, uv, depth, audioLevelDb).x;
}

// Mono helper using precomputed modulator outputs from evalModulators.
float applyModulationCachedMono(float value, float minValue, float maxValue, float[NUM_MODULATORS] modulationAmounts, float[NUM_CONTEXTUAL_MOD_SOURCES] contextualModAmounts, float[NUM_MACROS] macroAmounts, vec2 mods[NUM_MODULATORS]) {
  return applyModulationCached(value, minValue, maxValue, modulationAmounts, contextualModAmounts, macroAmounts, mods).x;
}