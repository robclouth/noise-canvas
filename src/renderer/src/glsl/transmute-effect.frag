#include "effect-common.glsl";
#include "effect-wrapper.glsl"

uniform int transmuteMode;
uniform Parameter transmuteAmount;
uniform Parameter transmuteCurve;

vec4 applyEffectStroke(vec4 src, ProcessingUvs coords, float audioLevelDb) {
  vec2 mods[NUM_MODULATORS];
  sampleModulators(mods);
  vec2 amount = applyModulationCached(
    transmuteAmount.value, transmuteAmount.minValue, transmuteAmount.maxValue,
    transmuteAmount.modulationAmounts, transmuteAmount.contextualModAmounts, transmuteAmount.macroAmounts,
    mods
  );
  vec2 curve = applyModulationCached(
    transmuteCurve.value, transmuteCurve.minValue, transmuteCurve.maxValue,
    transmuteCurve.modulationAmounts, transmuteCurve.contextualModAmounts, transmuteCurve.macroAmounts,
    mods
  );

  float magL   = src.x;
  float phaseL = src.y;
  float magR   = src.z;
  float phaseR = src.w;

  vec2 outL, outR;

  if (transmuteMode == 0) {
    // Swap Mag<->Phase: places phase into the magnitude slot and vice versa.
    // Use as bookends to sculpt phase via amplitude-targeting effects:
    //   Transmute(swap) -> [Effect] -> Transmute(swap)
    // amount blends between identity (0) and full swap (1).
    float blendL = clamp(abs(amount.x), 0.0, 1.0);
    float blendR = clamp(abs(amount.y), 0.0, 1.0);
    outL = mix(vec2(magL, phaseL), vec2(phaseL, magL), blendL);
    outR = mix(vec2(magR, phaseR), vec2(phaseR, magR), blendR);

  } else if (transmuteMode == 1) {
    // Complex Power: raise z = mag*e^(i*phase) to exponent p.
    // new mag = mag^p,  new phase = phase * p  (wrapped to [-pi, pi]).
    // p=2 doubles phase (harmonic redistribution); p=0.5 compresses both.
    // p=-1 inverts magnitude and negates phase.
    outL = vec2(pow(max(magL, EPSILON), amount.x), unwrapPhase(phaseL * amount.x));
    outR = vec2(pow(max(magR, EPSILON), amount.y), unwrapPhase(phaseR * amount.y));

  } else if (transmuteMode == 2) {
    // Phase Rotate: frequency-proportional phase rotation.
    // Adds  amount * 2pi * freqNorm^|curve|  radians to each bin's phase.
    // curve=1 -> linear sweep across spectrum; curve>1 -> concentrated at high freqs.
    float freqNorm = 1.0 - coords.dest.y;
    float rotationL = amount.x * TWO_PI * pow(freqNorm, max(abs(curve.x), 0.001));
    float rotationR = amount.y * TWO_PI * pow(freqNorm, max(abs(curve.y), 0.001));
    outL = vec2(magL, unwrapPhase(phaseL + rotationL));
    outR = vec2(magR, unwrapPhase(phaseR + rotationR));

  } else if (transmuteMode == 3) {
    // Phase Quantize: snaps phase to discrete steps around the unit circle.
    // amount*8 = step count (amount=1 -> 8 steps, amount=8 -> 64 steps).
    // Low step counts create digital, crystalline harmonic artifacts.
    float stepsL = max(2.0, abs(amount.x) * 8.0);
    float stepsR = max(2.0, abs(amount.y) * 8.0);
    float stepSizeL = TWO_PI / stepsL;
    float stepSizeR = TWO_PI / stepsR;
    float wL = unwrapPhase(phaseL);
    float wR = unwrapPhase(phaseR);
    outL = vec2(magL, round(wL / stepSizeL) * stepSizeL);
    outR = vec2(magR, round(wR / stepSizeR) * stepSizeR);

  } else if (transmuteMode == 4) {
    // Stereo Cross: independently cross-blend L/R magnitudes and phases.
    // amount: 0=no change, 1=full mag swap between channels.
    // curve:  0=no change, 1=full phase swap between channels.
    float magBlendL   = clamp(abs(amount.x), 0.0, 1.0);
    float magBlendR   = clamp(abs(amount.y), 0.0, 1.0);
    float phaseBlendL = clamp(abs(curve.x),  0.0, 1.0);
    float phaseBlendR = clamp(abs(curve.y),  0.0, 1.0);
    outL = vec2(mix(magL, magR, magBlendL),   mix(phaseL, phaseR, phaseBlendL));
    outR = vec2(mix(magR, magL, magBlendR),   mix(phaseR, phaseL, phaseBlendR));

  } else {
    // Phase Gate: gates magnitude by a sinusoidal function of the phase value.
    // Bins whose phase aligns with gate peaks keep amplitude; others are silenced.
    // amount=oscillation count, curve=gate sharpness (higher -> narrower peaks).
    float normPhaseL = (unwrapPhase(phaseL) + PI) / TWO_PI;
    float normPhaseR = (unwrapPhase(phaseR) + PI) / TWO_PI;
    float oscL   = max(1.0, abs(amount.x));
    float oscR   = max(1.0, abs(amount.y));
    float powerL = max(0.1, abs(curve.x));
    float powerR = max(0.1, abs(curve.y));
    outL = vec2(magL * pow(abs(sin(normPhaseL * oscL * PI)), powerL), phaseL);
    outR = vec2(magR * pow(abs(sin(normPhaseR * oscR * PI)), powerR), phaseR);
  }

  return vec4(outL, outR);
}
