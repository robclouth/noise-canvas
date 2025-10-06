precision highp float;
varying vec2 vUv;

#include "effect-common.glsl";
#include "effect-wrapper.glsl"

uniform Parameter thresholdDb;
uniform Parameter upperRatio;
uniform Parameter lowerRatio;
uniform Parameter knee;

// Helper function to apply dynamics to a single channel
// Returns the gain multiplier (not dB)
float applyDynamics(float inputDb, float thresholdDbValue, float upperRatioValue, float lowerRatioValue, float kneeValue) {
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
  float gainMultiplier = pow(10.0, (outputDb - inputDb) / 20.0);
  
  return gainMultiplier;
}

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords) {
  // Get modulated parameters
  float thresholdDbValue = applyModulation(thresholdDb.value, thresholdDb.minValue, thresholdDb.maxValue, thresholdDb.modulationAmounts, coords.dest, 0);
  float upperRatioValue = applyModulation(upperRatio.value, upperRatio.minValue, upperRatio.maxValue, upperRatio.modulationAmounts, coords.dest, 0);
  float lowerRatioValue = applyModulation(lowerRatio.value, lowerRatio.minValue, lowerRatio.maxValue, lowerRatio.modulationAmounts, coords.dest, 0);
  float kneeValue = applyModulation(knee.value, knee.minValue, knee.maxValue, knee.modulationAmounts, coords.dest, 0);
  
  // Extract left and right complex values
  vec2 complexL = sourceTexel.rg; // Left channel (real, imaginary)
  vec2 complexR = sourceTexel.ba; // Right channel (real, imaginary)
  
  // Calculate amplitude for each channel
  float amplitudeL = length(complexL);
  float amplitudeR = length(complexR);
  
  // Avoid log(0)
  amplitudeL = max(amplitudeL, EPSILON);
  amplitudeR = max(amplitudeR, EPSILON);
  
  // Convert to dB
  float inputDbL = 20.0 * log(amplitudeL) / log(10.0);
  float inputDbR = 20.0 * log(amplitudeR) / log(10.0);
  
  // Apply dynamics to each channel (returns gain multiplier)
  float gainFactorL = applyDynamics(inputDbL, thresholdDbValue, upperRatioValue, lowerRatioValue, kneeValue);
  float gainFactorR = applyDynamics(inputDbR, thresholdDbValue, upperRatioValue, lowerRatioValue, kneeValue);
  
  // Apply gain to complex values
  vec2 outputComplexL = complexL * gainFactorL;
  vec2 outputComplexR = complexR * gainFactorR;
  
  return vec4(outputComplexL, outputComplexR);
}
