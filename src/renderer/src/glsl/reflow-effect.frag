#include "effect-common.glsl"
#include "effect-wrapper.glsl"

// Reflow retunes the content under the brush by rewriting phase trajectories.
// Each band's true frequency is measured from the phase step between adjacent
// coefficients (band center + deviation), averaged across the brush span, and
// pulled toward a target frequency. The move is written as a phase ramp
// anchored at the brush start — magnitudes are never touched, so the retune
// stays clean within roughly a semitone of movement before the stationary
// magnitude ridge starts to attenuate the shifted carrier.

uniform int reflowMode; // 0=Scale, 1=Pitch, 2=Stretch
uniform Parameter reflowAmount;  // percent toward target (negative = away)
uniform Parameter reflowPitch;   // semitones relative to A4
uniform Parameter reflowStretch; // exponent around the Pitch anchor
uniform Parameter reflowReach;   // capture radius in semitones
uniform float reflowScaleOffsets[12];

const int   REFLOW_TAPS = 12;
const float REFLOW_C0_HZ = 16.3516;
// Applied moves cap at 2 semitones — beyond that a phase-only retune fights
// the unmoved magnitude ridge and mostly attenuates.
const float REFLOW_MAX_MOVE_RATIO = 0.12246; // 2^(2/12) - 1

// Snap absolute semitones (above C0) to the nearest in-scale pitch. Same
// candidate logic as transform's snapToScale: both chromatic neighbours are
// considered so near-boundary values pick the truly-closest scale note.
float reflowSnapToScale(float target) {
  float chromaLow = floor(target);
  float chromaHigh = chromaLow + 1.0;
  int pcLow = int(mod(chromaLow, 12.0));
  int pcHigh = int(mod(chromaHigh, 12.0));
  float candLow = chromaLow + reflowScaleOffsets[pcLow];
  float candHigh = chromaHigh + reflowScaleOffsets[pcHigh];
  return (abs(candLow - target) <= abs(candHigh - target)) ? candLow : candHigh;
}

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb) {
  vec2 mods[NUM_MODULATORS];
  sampleModulators(mods);
  vec2 amount = applyModulationCached(
    reflowAmount.value, reflowAmount.minValue, reflowAmount.maxValue,
    reflowAmount.modulationAmounts, reflowAmount.contextualModAmounts, reflowAmount.macroAmounts,
    mods
  );
  float pitchSemis = applyModulationCachedMono(
    reflowPitch.value, reflowPitch.minValue, reflowPitch.maxValue,
    reflowPitch.modulationAmounts, reflowPitch.contextualModAmounts, reflowPitch.macroAmounts,
    mods
  );
  float stretch = applyModulationCachedMono(
    reflowStretch.value, reflowStretch.minValue, reflowStretch.maxValue,
    reflowStretch.modulationAmounts, reflowStretch.contextualModAmounts, reflowStretch.macroAmounts,
    mods
  );
  float reachSemis = applyModulationCachedMono(
    reflowReach.value, reflowReach.minValue, reflowReach.maxValue,
    reflowReach.modulationAmounts, reflowReach.contextualModAmounts, reflowReach.macroAmounts,
    mods
  );

  // True frequency of this band, mag-weighted across the brush's time span.
  // The mean (not the per-pixel value) sets the correction, so the ramp added
  // below has a constant slope per band and the retune is a clean carrier
  // shift rather than amplified wobble.
  vec4 srcMeta = getSourceMetadata(coords.source);
  float fc = max(srcMeta.a, 1e-6);
  float dtSec = exp2(srcMeta.b) / max(sourceSampleRate, 1e-6);
  float strideUv = exp2(srcMeta.b) / max(sourceFrameCount, 1.0);

  float devSum = 0.0;
  float weightSum = 0.0;
  for (int k = 0; k < REFLOW_TAPS; k++) {
    float destX = brushBottomLeftUv.x + (float(k) + 0.5) / float(REFLOW_TAPS) * brushSizeUv.x;
    float srcX = destX * sourceTimeScale + sourceOffsetX;
    if (srcX < 0.0 || srcX + strideUv > 1.0) continue;
    vec4 s0 = sampleSourceNoInterp(vec2(srcX, coords.source.y));
    vec4 s1 = sampleSourceNoInterp(vec2(srcX + strideUv, coords.source.y));
    float w = getMag(s0.rg) + getMag(s0.ba);
    devSum += w * unwrapPhase(getPhase(s1.rg) - getPhase(s0.rg)) / (TWO_PI * dtSec);
    weightSum += w;
  }
  if (weightSum < 1e-7) return sourceTexel;
  float fMean = fc + devSum / weightSum;
  if (fMean < 20.0) return sourceTexel;

  float fTarget;
  if (reflowMode == 0) {
    float absSemis = 12.0 * log2(fMean / REFLOW_C0_HZ);
    fTarget = REFLOW_C0_HZ * exp2(reflowSnapToScale(absSemis) / 12.0);
  } else if (reflowMode == 1) {
    fTarget = 440.0 * exp2(pitchSemis / 12.0);
  } else {
    float fAnchor = 440.0 * exp2(pitchSemis / 12.0);
    fTarget = clamp(fAnchor * pow(fMean / fAnchor, stretch), 20.0, 20000.0);
  }

  float distSemis = abs(12.0 * log2(fTarget / fMean));
  if (distSemis > reachSemis) return sourceTexel;

  float maxMoveHz = fMean * REFLOW_MAX_MOVE_RATIO;
  vec2 corrHz = clamp((fTarget - fMean) * amount / 100.0, -maxMoveHz, maxMoveHz);

  // Phase ramp anchored at the brush start, so the stroke's left edge stays
  // continuous with what precedes it and the retune accumulates rightward.
  float anchorUvX = coords.dest.x - getEffectiveBrushOffset(coords.dest).x;
  float rampSec = (coords.dest.x - anchorUvX) * destFrameCount / max(destSampleRate, 1e-6);
  vec2 ramp = TWO_PI * corrHz * rampSec;

  return vec4(
    sourceTexel.x, sourceTexel.y + ramp.x,
    sourceTexel.z, sourceTexel.w + ramp.y
  );
}
