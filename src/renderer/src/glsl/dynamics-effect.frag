#include "effect-common.glsl";
#include "effect-wrapper.glsl"

uniform Parameter thresholdDb;
uniform Parameter upperRatio;
uniform Parameter lowerRatio;
uniform Parameter knee;
uniform Parameter gainDb;

// Helper function to apply dynamics to a single channel
// Returns the gain multiplier (not dB)
float applyDynamics(float inputDb, float thresholdDbValue, float upperRatioValue, float lowerRatioValue, float kneeValue, float gainDbValue) {
  float overThreshold = inputDb - thresholdDbValue;
  float ratio;
  
  if (kneeValue > 0.0) {
    // Soft knee - smooth transition
    float kneeHalf = kneeValue / 2.0;
    
    if (overThreshold < -kneeHalf) {
      // Below knee - use lower ratio
      ratio = lowerRatioValue;
    } else if (overThreshold > kneeHalf) {
      // Above knee - use upper ratio
      ratio = upperRatioValue;
    } else {
      // In the knee region - interpolate between lower and upper ratios
      float blend = (overThreshold + kneeHalf) / kneeValue; // 0 at bottom, 1 at top
      ratio = mix(lowerRatioValue, upperRatioValue, blend);
    }
  } else {
    // Hard knee - sharp transition at threshold
    if (overThreshold > 0.0) {
      ratio = upperRatioValue;
    } else {
      ratio = lowerRatioValue;
    }
  }
  
  // Calculate output dB
  // For positive ratio: simple gain multiplication
  // For negative ratio: invert dynamics around threshold
  float outputDb;
  if (ratio >= 0.0) {
    // Positive ratio: just multiply the amplitude
    // In dB: adding 20*log10(ratio) is the same as multiplying amplitude by ratio
    // But we'll calculate the gain directly below
    outputDb = inputDb + 20.0 * log(max(ratio, EPSILON)) / log(10.0);
  } else {
    // Negative ratio: invert around threshold
    // outputDb = threshold - (inputDb - threshold) * abs(ratio)
    outputDb = thresholdDbValue - (inputDb - thresholdDbValue) * abs(ratio);
  }
  
  // Convert dB change to linear gain multiplier
  float gainMultiplier = pow(10.0, (outputDb - inputDb + gainDbValue) / 20.0);
  
  return gainMultiplier;
}

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb) {
  // Per-pixel dB transforms — each channel receives its own curve.
  bool used[NUM_MODULATORS];
  for (int _mi = 0; _mi < NUM_MODULATORS; _mi++) {
    used[_mi] = (thresholdDb.modulationAmounts[_mi] != 0.0) || (upperRatio.modulationAmounts[_mi] != 0.0) || (lowerRatio.modulationAmounts[_mi] != 0.0) || (knee.modulationAmounts[_mi] != 0.0) || (gainDb.modulationAmounts[_mi] != 0.0);
  }
  vec2 mods[NUM_MODULATORS];
  evalModulators(coords.dest, 0, audioLevelDb, used, mods);
  vec2 thresholdDbValue = applyModulationCached(thresholdDb.value, thresholdDb.minValue, thresholdDb.maxValue, thresholdDb.modulationAmounts, thresholdDb.contextualModAmounts, thresholdDb.macroAmounts, mods);
  vec2 upperRatioValue = applyModulationCached(upperRatio.value, upperRatio.minValue, upperRatio.maxValue, upperRatio.modulationAmounts, upperRatio.contextualModAmounts, upperRatio.macroAmounts, mods);
  vec2 lowerRatioValue = applyModulationCached(lowerRatio.value, lowerRatio.minValue, lowerRatio.maxValue, lowerRatio.modulationAmounts, lowerRatio.contextualModAmounts, lowerRatio.macroAmounts, mods);
  vec2 kneeValue = applyModulationCached(knee.value, knee.minValue, knee.maxValue, knee.modulationAmounts, knee.contextualModAmounts, knee.macroAmounts, mods);
  vec2 gainDbValue = applyModulationCached(gainDb.value, gainDb.minValue, gainDb.maxValue, gainDb.modulationAmounts, gainDb.contextualModAmounts, gainDb.macroAmounts, mods);

  // Calculate amplitude for each channel
  float amplitudeL = max(sourceTexel.x, EPSILON);
  float amplitudeR = max(sourceTexel.z, EPSILON);

  // Convert to dB
  float inputDbL = 20.0 * log(amplitudeL) / log(10.0);
  float inputDbR = 20.0 * log(amplitudeR) / log(10.0);

  // Apply dynamics to each channel with that channel's modulated curve.
  float gainFactorL = applyDynamics(inputDbL, thresholdDbValue.x, upperRatioValue.x, lowerRatioValue.x, kneeValue.x, gainDbValue.x);
  float gainFactorR = applyDynamics(inputDbR, thresholdDbValue.y, upperRatioValue.y, lowerRatioValue.y, kneeValue.y, gainDbValue.y);

  return vec4(vec2(sourceTexel.x * gainFactorL, sourceTexel.y), vec2(sourceTexel.z * gainFactorR, sourceTexel.w));
}
