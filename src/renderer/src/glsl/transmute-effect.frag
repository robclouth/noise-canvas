#include "effect-common.glsl";
#include "effect-wrapper.glsl"

uniform int transmuteMode;
uniform Parameter transmuteAmount;
uniform Parameter transmuteCurve;

// Draws the wrapped phase into the level slot as a 0..window image, and leaves
// the phase itself alone so the passes in between still read a real one.
vec2 openSwap(vec2 magPhase, float window) {
  return vec2((unwrapPhase(magPhase.y) + PI) / TWO_PI * window, magPhase.y);
}

// Reads the image back out as the phase, and takes the level from what the
// pixel held when the stroke began. That reference is what stops content a pass
// in between dragged in from outside the swap — which still carries a full,
// unwrapped phase — from coming back as a band at full level.
vec2 closeSwap(vec2 magPhase, vec2 strokeStart, float window) {
  float wrapped = clamp(magPhase.x / window, 0.0, 1.0) * TWO_PI - PI;
  return vec2(strokeStart.x, round(strokeStart.y / TWO_PI) * TWO_PI + wrapped);
}

// Quantises the phase to `steps` around the circle, keeping the whole turns.
float quantisePhase(float phase, float steps) {
  float wrapped = unwrapPhase(phase);
  float stepSize = TWO_PI / steps;
  return phase - wrapped + round(wrapped / stepSize) * stepSize;
}

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
    // Swap Mag/Phase: puts the phase in the level slot so level-shaping effects
    // reach it. A second Transmute in swap mode later in the chain puts it back:
    //   Transmute(swap) -> [Effect] -> Transmute(swap)
    // amount is the window, in level units, the phase image spans.
    float windowL = max(abs(amount.x), 1e-3);
    float windowR = max(abs(amount.y), 1e-3);
    if (inSwappedDomain) {
      vec4 strokeStart = texture(blendOriginalTex, vUv);
      outL = closeSwap(vec2(magL, phaseL), strokeStart.rg, windowL);
      outR = closeSwap(vec2(magR, phaseR), strokeStart.ba, windowR);
    } else {
      outL = openSwap(vec2(magL, phaseL), windowL);
      outR = openSwap(vec2(magR, phaseR), windowR);
    }

  } else if (transmuteMode == 1) {
    // Phase Multiply: scales the phase advance, which multiplies the frequency
    // each band's content runs at while its level stays where it is. 2 doubles
    // it, 0 flattens every band to cosine phase, -1 runs it backwards.
    // curve is the level exponent, capped so a negative one cannot blow up.
    outL = vec2(min(pow(max(magL, EPSILON), curve.x), 16.0), phaseL * amount.x);
    outR = vec2(min(pow(max(magR, EPSILON), curve.y), 16.0), phaseR * amount.y);

  } else if (transmuteMode == 2) {
    // Disperse: delays each band by 2pi*f*delay radians of its own phase, with
    // the delay growing toward the top of the spectrum, which smears transients
    // into a chirp. amount is the delay at the top band, in units of 20 ms, and
    // curve tilts how far down the spectrum the delay reaches.
    float freqHz = getDestMetadata(coords.dest).a;
    float topFreqHz = max(fetchBandMetadata(destMetadataTex, 0.0).a, 1e-6);
    float freqNorm = clamp(freqHz / topFreqHz, 0.0, 1.0);
    float tiltL = pow(freqNorm, max(abs(curve.x), 0.001));
    float tiltR = pow(freqNorm, max(abs(curve.y), 0.001));
    outL = vec2(magL, phaseL + TWO_PI * freqHz * amount.x * 0.02 * tiltL);
    outR = vec2(magR, phaseR + TWO_PI * freqHz * amount.y * 0.02 * tiltR);

  } else if (transmuteMode == 3) {
    // Phase Quantize: snaps the phase to discrete steps around the unit circle.
    // steps = 2^|amount|, so 1 is the two-step crunch and 8 is 256 steps.
    outL = vec2(magL, quantisePhase(phaseL, clamp(pow(2.0, abs(amount.x)), 2.0, 4096.0)));
    outR = vec2(magR, quantisePhase(phaseR, clamp(pow(2.0, abs(amount.y)), 2.0, 4096.0)));

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
    // amount sets the lobe count, curve the gate sharpness.
    float normPhaseL = (unwrapPhase(phaseL) + PI) / TWO_PI;
    float normPhaseR = (unwrapPhase(phaseR) + PI) / TWO_PI;
    float lobesL = 1.0 + abs(amount.x) * 3.0;
    float lobesR = 1.0 + abs(amount.y) * 3.0;
    float sharpL = pow(3.0, abs(curve.x));
    float sharpR = pow(3.0, abs(curve.y));
    outL = vec2(magL * pow(abs(sin(normPhaseL * lobesL * PI)), sharpL), phaseL);
    outR = vec2(magR * pow(abs(sin(normPhaseR * lobesR * PI)), sharpR), phaseR);
  }

  return vec4(outL, outR);
}
