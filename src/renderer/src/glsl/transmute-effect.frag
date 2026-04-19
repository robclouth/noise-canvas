#include "effect-common.glsl";
#include "effect-wrapper.glsl"

uniform int transmuteMode;
uniform Parameter transmuteAmount;
uniform Parameter transmuteCurve;

vec4 applyEffectStroke(vec4 src, ProcessingUvs coords, float audioLevelDb) {
  float amount = applyModulation(
    transmuteAmount.value, transmuteAmount.minValue, transmuteAmount.maxValue,
    transmuteAmount.modulationAmounts, transmuteAmount.contextualModAmounts, transmuteAmount.macroAmounts,
    coords.dest, 0, audioLevelDb
  );
  float curve = applyModulation(
    transmuteCurve.value, transmuteCurve.minValue, transmuteCurve.maxValue,
    transmuteCurve.modulationAmounts, transmuteCurve.contextualModAmounts, transmuteCurve.macroAmounts,
    coords.dest, 0, audioLevelDb
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
    float blend = clamp(abs(amount), 0.0, 1.0);
    outL = mix(vec2(magL, phaseL), vec2(phaseL, magL), blend);
    outR = mix(vec2(magR, phaseR), vec2(phaseR, magR), blend);

  } else if (transmuteMode == 1) {
    // Complex Power: raise z = mag*e^(i*phase) to exponent p.
    // new mag = mag^p,  new phase = phase * p  (wrapped to [-pi, pi]).
    // p=2 doubles phase (harmonic redistribution); p=0.5 compresses both.
    // p=-1 inverts magnitude and negates phase.
    float p = amount;
    outL = vec2(pow(max(magL, EPSILON), p), unwrapPhase(phaseL * p));
    outR = vec2(pow(max(magR, EPSILON), p), unwrapPhase(phaseR * p));

  } else if (transmuteMode == 2) {
    // Phase Rotate: frequency-proportional phase rotation.
    // Adds  amount * 2pi * freqNorm^|curve|  radians to each bin's phase.
    // curve=1 -> linear sweep across spectrum; curve>1 -> concentrated at high freqs.
    float freqNorm = 1.0 - coords.dest.y;
    float rotation = amount * TWO_PI * pow(freqNorm, max(abs(curve), 0.001));
    outL = vec2(magL, unwrapPhase(phaseL + rotation));
    outR = vec2(magR, unwrapPhase(phaseR + rotation));

  } else if (transmuteMode == 3) {
    // Phase Quantize: snaps phase to discrete steps around the unit circle.
    // amount*8 = step count (amount=1 -> 8 steps, amount=8 -> 64 steps).
    // Low step counts create digital, crystalline harmonic artifacts.
    float steps    = max(2.0, abs(amount) * 8.0);
    float stepSize = TWO_PI / steps;
    float wL = unwrapPhase(phaseL);
    float wR = unwrapPhase(phaseR);
    outL = vec2(magL, round(wL / stepSize) * stepSize);
    outR = vec2(magR, round(wR / stepSize) * stepSize);

  } else if (transmuteMode == 4) {
    // Stereo Cross: independently cross-blend L/R magnitudes and phases.
    // amount: 0=no change, 1=full mag swap between channels.
    // curve:  0=no change, 1=full phase swap between channels.
    float magBlend   = clamp(abs(amount), 0.0, 1.0);
    float phaseBlend = clamp(abs(curve),  0.0, 1.0);
    outL = vec2(mix(magL, magR, magBlend),   mix(phaseL, phaseR, phaseBlend));
    outR = vec2(mix(magR, magL, magBlend),   mix(phaseR, phaseL, phaseBlend));

  } else {
    // Phase Gate: gates magnitude by a sinusoidal function of the phase value.
    // Bins whose phase aligns with gate peaks keep amplitude; others are silenced.
    // amount=oscillation count, curve=gate sharpness (higher -> narrower peaks).
    float normPhaseL = (unwrapPhase(phaseL) + PI) / TWO_PI;
    float normPhaseR = (unwrapPhase(phaseR) + PI) / TWO_PI;
    float osc   = max(1.0, abs(amount));
    float power = max(0.1, abs(curve));
    outL = vec2(magL * pow(abs(sin(normPhaseL * osc * PI)), power), phaseL);
    outR = vec2(magR * pow(abs(sin(normPhaseR * osc * PI)), power), phaseR);
  }

  return vec4(outL, outR);
}
