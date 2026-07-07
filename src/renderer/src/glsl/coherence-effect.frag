#include "effect-common.glsl"

// Coherence: derive intra-band phase from the magnitude gradient and integrate
// it along time, so painted/synthesised magnitude stops sounding "phasey".
//
// For a Gaussian (constant-Q) window, log-magnitude and phase are conjugate,
// so the instantaneous-frequency deviation is available pointwise from the
// magnitude:  ∂φ/∂t = (1/σ_t²)·∂(log|X|)/∂f   (relation A). Integrating that
// along each band's own time axis turns a steady magnitude ridge into a steady
// tone and a drifting ridge into a coherent chirp.
//
// Bands are not left to integrate independently: a partial excites a ridge
// band plus Gaussian skirts, and independently-integrated skirts accumulate
// phase error against the ridge, which resynthesises as a sweeping comb. After
// the scan, a vertical lock pass reassigns skirt phases from their magnitude
// ridge: for a partial near ridge band f_r, the stored phase at band f_b is
// the ridge phase plus 2π·(f_r − f_b)·t, exact for a Gaussian atom in this
// storage convention.
//
// Locking is membership-tested, not blanket. A locked band synthesises at the
// ridge's instantaneous frequency, so locking everything within reach folds
// all between-peak content (noise floor, weaker neighbours) into the peaks —
// a sinusoidal-model/vocoder sound. Two guards prevent that: the ridge is
// found by hill-climbing to the nearest local maximum (a weaker partial with
// its own peak keeps its own identity), and lock strength fades as the
// pixel's magnitude exceeds the ridge atom's predicted Gaussian skirt at that
// distance.
//
// The rebuilt phase is applied only where the ridge-atom model is confident.
// Relation A assumes the local magnitude is one Gaussian atom; on broadband
// content the global spectral tilt reads as a fake everywhere-downward
// frequency deviation, and integrating it re-tunes all non-ridge content
// against the ridges (a sweeping comb). So at the blend, pixels without a
// confident ridge model keep the canvas phase untouched: noise phase is not
// broken and needs no repair, and onset alignment is the Align effect's job.
//
// The integral is a Hillis–Steele inclusive prefix scan over band-local time,
// run as a fixed ladder of ping-pong passes (extra passes are no-ops once the
// stride exceeds the band length). Cross-band transient alignment at an onset
// is a different operation — chain Coherence → Align for the impulse "crack".
//
// Pass plan (coherencePass):
//   0  seed  — magnitude passthrough, per-step phase increment in phase slots
//   1  scan  — accumulate the increment at stride coherenceScanStride
//   2  lock  — replace each pixel's phase from its local magnitude ridge
//   3  blend — mix locked phase with the original phase under the brush

uniform int   coherencePass;
uniform float coherenceScanStride;
// The effect's input spectrogram (the canvas as this effect first saw it),
// stable across all passes — the ping-pong overwrites destSpectrogramTex.
uniform sampler2D coherenceCanvasTex;
uniform Parameter coherenceAmount;
uniform Parameter coherenceSharpness;
uniform Parameter coherenceStrictness;
uniform Parameter coherenceAttack;

const float COH_SUPPORT_GAIN = 0.7;   // per-band Gabor time support, in bands/Hz
const float COH_MAX_STEP     = PI;    // clamp per-step phase advance (anti-alias)
const int   COH_LOCK_RADIUS  = 4;     // bands searched either side for the ridge
const int   COH_LOCK_N       = 2 * COH_LOCK_RADIUS + 1;
// Assumed atom cross-section width in bands (log-f Gaussian). Deliberately
// wider than the theoretical Gabor value (~0.66): real ridges are smeared by
// vibrato and prior processing, and an unlocked true skirt drifts against its
// ridge and combs. Vocoder-style over-locking is prevented by the hill-climb
// (it never crosses a magnitude valley), not by this width. Mirrored by the
// vertical-lock unit test's painted ridge.
const float COH_ATOM_SIGMA_BANDS = 1.3;
// Lock fades to zero as the pixel exceeds the ridge's predicted skirt by this
// much (natural log units; 2.0 ≈ 17 dB).
const float COH_LOCK_MARGIN = 2.0;
// Attack detection: a bin-to-bin log-magnitude rise counts as an onset from
// ~3 dB (ramping to full effect at ~10 dB), searched this many bins back.
const float COH_ATTACK_RISE      = 0.35;
const float COH_ATTACK_RISE_FULL = 1.2;
const int   COH_ATTACK_LOOKBACK  = 16;

struct BandCtx {
  float startOffset;   // linear pixel offset of the band in the packed texture
  float length;        // number of time samples in the band
  float cellFrames;    // full-res frames per band sample (2^timeScaleExp)
  float fHz;           // band centre frequency
  float localTime;     // this fragment's band-local time index
};

BandCtx getBandCtx(vec2 destUv) {
  BandCtx c;
  vec4 meta = getDestMetadata(destUv);
  c.startOffset = meta.r;
  c.length      = meta.g;
  c.cellFrames  = exp2(meta.b);
  c.fHz         = max(meta.a, 1e-6);
  // Band-local time index from the fragment's exact packed pixel index. Deriving
  // it from the UV round-trip can round to a neighbouring sample, which would
  // fetch the wrong band-local time in the scan.
  ivec2 texSize = textureSize(destSpectrogramTex, 0);
  float linIdx  = floor(gl_FragCoord.y) * float(texSize.x) + floor(gl_FragCoord.x);
  c.localTime   = clamp(linIdx - c.startOffset, 0.0, c.length - 1.0);
  return c;
}

// Relation A evaluated at this fragment, scaled to a per-time-step phase advance.
// True digital silence yields a zero gradient (both logs collapse to the same
// floor), so no separate silence gate is needed; noisy low-level estimates are
// superseded by the lock pass.
vec2 seedIncrement(vec2 destUv, BandCtx c, float sharpness) {
  float dBand = 1.0 / max(destBandCount, 1.0);
  vec2 uvUp = vec2(destUv.x, destUv.y + dBand);
  vec2 uvDn = vec2(destUv.x, destUv.y - dBand);

  vec4 up = readPackedData(uvUp, destSpectrogramTex, destMetadataTex, destFrameCount, destBandCount);
  vec4 dn = readPackedData(uvDn, destSpectrogramTex, destMetadataTex, destFrameCount, destBandCount);

  float fUp = getDestMetadata(uvUp).a;
  float fDn = getDestMetadata(uvDn).a;
  float df  = fUp - fDn;
  if (abs(df) < 1e-6) return vec2(0.0);

  // widthSec follows the impulse-branch convention mag = exp(-(t/width)²); the
  // π-normalised Gaussian scale relation A needs is σ_t² = π·width², so the
  // conversion divides by π·width². Without the π the recovered frequency
  // deviations are 3.14× too large and unlocked bands fan out into a comb.
  float widthSec = (destBandsPerOctave * COH_SUPPORT_GAIN) / (c.fHz * sharpness);
  float invS2    = 1.0 / max(PI * widthSec * widthSec, 1e-12);
  float dtSec    = c.cellFrames / destSampleRate;

  float dsdfL = (log(getMag(up.rg) + 1e-9) - log(getMag(dn.rg) + 1e-9)) / df;
  float dsdfR = (log(getMag(up.ba) + 1e-9) - log(getMag(dn.ba) + 1e-9)) / df;

  float dL = clamp(dsdfL * invS2 * dtSec, -COH_MAX_STEP, COH_MAX_STEP);
  float dR = clamp(dsdfR * invS2 * dtSec, -COH_MAX_STEP, COH_MAX_STEP);
  return vec2(dL, dR);
}

// Interpolate two phases through the complex plane so the mix wraps correctly.
float blendPhase(float origPhase, float cohPhase, float w) {
  vec2 z = mix(vec2(cos(origPhase), sin(origPhase)), vec2(cos(cohPhase), sin(cohPhase)), w);
  return atan(z.y, z.x);
}

// Hill-climb from the centre of a magnitude window to the nearest local
// maximum. Steps must exceed a relative epsilon: the neighbour magnitudes go
// through a log/exp interpolation round-trip, so exactly-equal texels read
// back with ~1e-8 noise, and a strict comparison would invent phantom ridges
// in flat regions (which then partially re-tune them via the lock carrier).
const float COH_CLIMB_EPS = 1.001;

int climbToRidge(const float mags[COH_LOCK_N]) {
  int i = COH_LOCK_RADIUS;
  int dir = 0;
  if (mags[i + 1] > mags[i] * COH_CLIMB_EPS || mags[i - 1] > mags[i] * COH_CLIMB_EPS) {
    dir = mags[i + 1] > mags[i - 1] ? 1 : -1;
  }
  if (dir != 0) {
    for (int s = 0; s < COH_LOCK_RADIUS; s++) {
      int n = i + dir;
      if (n < 0 || n >= COH_LOCK_N) break;
      if (mags[n] <= mags[i] * COH_CLIMB_EPS) break;
      i = n;
    }
  }
  return i;
}

// Lock weight: full when the pixel sits at or below the ridge atom's predicted
// Gaussian skirt at this band distance, fading out as it exceeds it (content
// that loud is its own signal, not the ridge's skirt). Also requires the ridge
// to be prominent above the pixel (~1-4 dB ramp): a true atom skirt is 5+ dB
// below its ridge, while noise micro-peaks barely stand out — locking to those
// would slowly re-tune noise toward its local maxima.
float lockWeight(float ownMag, float ridgeMag, float distBands) {
  float arg = distBands / COH_ATOM_SIGMA_BANDS;
  float predicted = ridgeMag * exp(-arg * arg);
  float excess = log((ownMag + 1e-9) / (predicted + 1e-9));
  float w = 1.0 - smoothstep(0.0, COH_LOCK_MARGIN, excess);
  float prominence = log((ridgeMag + 1e-9) / (ownMag + 1e-9));
  return w * smoothstep(0.1, 0.5, prominence);
}

// Confidence that this pixel is described by the ridge-atom model at all: for
// a skirt pixel, the lock weight toward its climbed ridge; for a pixel that is
// itself the peak, its prominence over the immediate neighbours. Everything
// else (noise floor, broadband wash) keeps the canvas phase at the blend.
vec2 ridgeConfidence(vec2 destUv, vec4 self) {
  float dBand = 1.0 / max(destBandCount, 1.0);
  float magsL[COH_LOCK_N];
  float magsR[COH_LOCK_N];
  for (int j = -COH_LOCK_RADIUS; j <= COH_LOCK_RADIUS; j++) {
    int idx = j + COH_LOCK_RADIUS;
    vec2 nUv = vec2(destUv.x, clamp(destUv.y + float(j) * dBand, 0.0, 1.0));
    vec4 nb = j == 0 ? self : sampleSourceInterp(nUv);
    magsL[idx] = getMag(nb.rg);
    magsR[idx] = getMag(nb.ba);
  }
  int center = COH_LOCK_RADIUS;
  int rL = climbToRidge(magsL);
  int rR = climbToRidge(magsR);
  float confL = rL != center
    ? lockWeight(magsL[center], magsL[rL], float(abs(rL - center)))
    : smoothstep(0.1, 0.5, log((magsL[center] + 1e-9) / (max(magsL[center - 1], magsL[center + 1]) + 1e-9)));
  float confR = rR != center
    ? lockWeight(magsR[center], magsR[rR], float(abs(rR - center)))
    : smoothstep(0.1, 0.5, log((magsR[center] + 1e-9) / (max(magsR[center - 1], magsR[center + 1]) + 1e-9)));
  return vec2(confL, confR);
}

void main() {
  vec2 destUv = packedToUnpackedUv(destInverseMapTex, vUv, destFrameCount, destBandCount);
  BandCtx c = getBandCtx(destUv);

  vec2 mods[NUM_MODULATORS];
  sampleModulators(mods);
  float sharpness = applyModulationCached(
    coherenceSharpness.value, coherenceSharpness.minValue, coherenceSharpness.maxValue,
    coherenceSharpness.modulationAmounts, coherenceSharpness.contextualModAmounts,
    coherenceSharpness.macroAmounts, mods).x;
  // Map the 1..100 control to a σ_t scale around 1 (50 -> align-matched support).
  float sharpnessFactor = max(sharpness / 50.0, 0.02);
  // Strictness sweeps repair -> sculpt: at 100 the ridge-model gates apply in
  // full (painted textures without clean ridges pass through untouched); at 0
  // every pixel is re-phased by the model, deliberately re-tuning broadband
  // content onto its local ridges.
  float strict = applyModulationCached(
    coherenceStrictness.value, coherenceStrictness.minValue, coherenceStrictness.maxValue,
    coherenceStrictness.modulationAmounts, coherenceStrictness.contextualModAmounts,
    coherenceStrictness.macroAmounts, mods).x / 100.0;

  if (coherencePass == 0) {
    vec4 here = texture(destSpectrogramTex, vUv);
    vec2 inc = seedIncrement(destUv, c, sharpnessFactor);
    outColor = vec4(getMag(here.rg), inc.x, getMag(here.ba), inc.y);
    return;
  }

  if (coherencePass == 1) {
    vec4 self = texture(sourceSpectrogramTex, vUv);
    float PL = self.g;
    float PR = self.a;
    float nt = c.localTime - coherenceScanStride;
    if (nt >= 0.0) {
      vec4 nb = readSourceAtTimeIndex(nt, c.startOffset);
      PL += nb.g;
      PR += nb.a;
    }
    outColor = vec4(self.r, PL, self.b, PR);
    return;
  }

  if (coherencePass == 2) {
    // Vertical lock: hill-climb to the local magnitude ridge and, when this
    // pixel matches the ridge atom's skirt, adopt the ridge's integrated phase
    // offset by the exact Gaussian-atom carrier 2π·(f_ridge − f_band)·t.
    // Locked skirts advance in lockstep with their ridge instead of on their
    // own noisy integral. Unlocked pixels carry their own integral forward,
    // but the blend discards it (low ridge confidence keeps the canvas phase).
    // Hard region switches land in magnitude valleys where the resulting
    // phase seam is inaudible.
    vec4 self = texture(sourceSpectrogramTex, vUv);
    float dBand = 1.0 / max(destBandCount, 1.0);
    float tSec  = destUv.x * destFrameCount / destSampleRate;

    float magsL[COH_LOCK_N];
    float magsR[COH_LOCK_N];
    float phasesL[COH_LOCK_N];
    float phasesR[COH_LOCK_N];
    float freqs[COH_LOCK_N];

    for (int j = -COH_LOCK_RADIUS; j <= COH_LOCK_RADIUS; j++) {
      int idx = j + COH_LOCK_RADIUS;
      vec2 nUv = vec2(destUv.x, clamp(destUv.y + float(j) * dBand, 0.0, 1.0));
      vec4 nb = j == 0 ? self : sampleSourceInterp(nUv);
      magsL[idx]   = getMag(nb.rg);
      magsR[idx]   = getMag(nb.ba);
      phasesL[idx] = getPhase(nb.rg);
      phasesR[idx] = getPhase(nb.ba);
      freqs[idx]   = j == 0 ? c.fHz : getDestMetadata(nUv).a;
    }

    int rL = climbToRidge(magsL);
    int rR = climbToRidge(magsR);
    int center = COH_LOCK_RADIUS;

    float lockedL = phasesL[center];
    float lockedR = phasesR[center];
    if (rL != center) {
      float target = phasesL[rL] + TWO_PI * (freqs[rL] - freqs[center]) * tSec;
      float w = mix(1.0, lockWeight(magsL[center], magsL[rL], float(abs(rL - center))), strict);
      lockedL = blendPhase(lockedL, target, w);
    }
    if (rR != center) {
      float target = phasesR[rR] + TWO_PI * (freqs[rR] - freqs[center]) * tSec;
      float w = mix(1.0, lockWeight(magsR[center], magsR[rR], float(abs(rR - center))), strict);
      lockedR = blendPhase(lockedR, target, w);
    }
    outColor = vec4(getMag(self.rg), lockedL, getMag(self.ba), lockedR);
    return;
  }

  // Blend: mix the locked coherent phase with the effect-input canvas phase
  // under the brush envelope. Magnitude is preserved exactly.
  vec4 acc  = texture(sourceSpectrogramTex, vUv);
  vec4 orig = texture(coherenceCanvasTex, vUv);

  float audioLevelDb = getAudioLevelDb(destUv);
  vec2 weight = getBrushWeight(destUv, audioLevelDb);
  vec2 amount = applyModulationCached(
    coherenceAmount.value, coherenceAmount.minValue, coherenceAmount.maxValue,
    coherenceAmount.modulationAmounts, coherenceAmount.contextualModAmounts,
    coherenceAmount.macroAmounts, mods) / 100.0;

  // Near-binary application: an intermediate phase mix between the canvas and
  // the coherent field (two signals that drift apart) is itself a growing-delay
  // comb, so a graded brush envelope must not grade the phase — painted pixels
  // get the full coherent phase, edges keep the canvas, with a narrow
  // transition ring. Confidence then restricts the rebuild to pixels the
  // ridge-atom model actually describes (relaxed by strictness).
  vec2 conf = mix(vec2(1.0), ridgeConfidence(destUv, acc), strict);
  float gateL = smoothstep(0.25, 0.75, weight.x * amount.x);
  float gateR = smoothstep(0.25, 0.75, weight.y * amount.y);

  float outPhaseL = blendPhase(getPhase(orig.rg), getPhase(acc.rg), gateL * conf.x);
  float outPhaseR = blendPhase(getPhase(orig.ba), getPhase(acc.ba), gateR * conf.y);

  // Attack: snap phase to the impulse convention −2π·f·T at the most recent
  // sharp magnitude rise in this band, fading over the atom's time support.
  // Vertical structure painted into the magnitude then resynthesises as an
  // aligned onset instead of an incoherent fade-in.
  float attack = applyModulationCached(
    coherenceAttack.value, coherenceAttack.minValue, coherenceAttack.maxValue,
    coherenceAttack.modulationAmounts, coherenceAttack.contextualModAmounts,
    coherenceAttack.macroAmounts, mods).x / 100.0;

  if (attack > 0.0) {
    float riseL = 0.0;
    float riseR = 0.0;
    float edgeL = -1.0;
    float edgeR = -1.0;
    vec4 cur = acc;
    for (int i = 1; i <= COH_ATTACK_LOOKBACK; i++) {
      float t0 = c.localTime - float(i);
      if (t0 < 0.0) break;
      vec4 prev = readSourceAtTimeIndex(t0, c.startOffset);
      float rl = log(getMag(cur.rg) + 1e-9) - log(getMag(prev.rg) + 1e-9);
      float rr = log(getMag(cur.ba) + 1e-9) - log(getMag(prev.ba) + 1e-9);
      if (edgeL < 0.0 && rl > COH_ATTACK_RISE) { edgeL = t0 + 1.0; riseL = rl; }
      if (edgeR < 0.0 && rr > COH_ATTACK_RISE) { edgeR = t0 + 1.0; riseR = rr; }
      if (edgeL >= 0.0 && edgeR >= 0.0) break;
      cur = prev;
    }

    float tSecPix   = destUv.x * destFrameCount / destSampleRate;
    float supportSec = (destBandsPerOctave * COH_SUPPORT_GAIN) / c.fHz;
    if (edgeL >= 0.0) {
      float tEdge = edgeL * c.cellFrames / destSampleRate;
      float arg   = (tSecPix - tEdge) / max(supportSec, 1e-6);
      float wA    = attack * smoothstep(COH_ATTACK_RISE, COH_ATTACK_RISE_FULL, riseL) * exp(-arg * arg) * gateL;
      outPhaseL   = blendPhase(outPhaseL, -TWO_PI * c.fHz * tEdge, wA);
    }
    if (edgeR >= 0.0) {
      float tEdge = edgeR * c.cellFrames / destSampleRate;
      float arg   = (tSecPix - tEdge) / max(supportSec, 1e-6);
      float wA    = attack * smoothstep(COH_ATTACK_RISE, COH_ATTACK_RISE_FULL, riseR) * exp(-arg * arg) * gateR;
      outPhaseR   = blendPhase(outPhaseR, -TWO_PI * c.fHz * tEdge, wA);
    }
  }

  outColor = vec4(getMag(acc.rg), outPhaseL, getMag(acc.ba), outPhaseR);
}
