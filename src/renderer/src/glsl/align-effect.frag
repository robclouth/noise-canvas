#include "effect-common.glsl"
#include "effect-wrapper.glsl"

const float ALIGN_ANCHOR_01    = 0.0;
const float ALIGN_STRENGTH     = 1.0;
const float ALIGN_DECAY_SEC    = 0.01;
const float ALIGN_PREROLL      = 1.0;
const float ALIGN_TILT_SPO     = 0.0;
const float ALIGN_SUPPORT_GAIN = 0.7;
const float ALIGN_MAG_GATE     = 0.1;

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb) {
  vec4 meta = getDestMetadata(coords.dest);
  float fHz = max(meta.a, 1e-6);

  float anchorUvX  = brushBottomLeftUv.x + ALIGN_ANCHOR_01 * brushSizeUv.x;
  float anchorSec  = anchorUvX * destFrameCount / destSampleRate;
  float octaves    = log2(fHz / max(destMinFreq, 1e-6));
  float bandAnchor = anchorSec + ALIGN_TILT_SPO * octaves;

  float pixelSec = coords.dest.x * destFrameCount / destSampleRate;
  float distSec  = pixelSec - bandAnchor;

  // Symmetric Gaussian coherence. Sigma combines per-band Gabor support (wide
  // at LF, narrow at HF) with a floor decay so HF still gets a usable window.
  float supportSec = (destBandsPerOctave * ALIGN_SUPPORT_GAIN) / fHz;
  float sigma      = max(supportSec * ALIGN_PREROLL, ALIGN_DECAY_SEC);
  float arg        = distSec / sigma;
  float coherence  = exp(-arg * arg);

  float magL = getMag(sourceTexel.rg);
  float magR = getMag(sourceTexel.ba);
  if (magL + magR < 1e-7) return sourceTexel;

  // Gate coherence by local magnitude so half-aligned low-energy pixels in the
  // decay tail don't leak partial-impulse contributions that read as a chirp.
  float magGate = clamp((magL + magR) * 0.5 / ALIGN_MAG_GATE, 0.0, 1.0);
  coherence *= magGate;

  float blend = clamp(ALIGN_STRENGTH * coherence, 0.0, 1.0);

  // Gaborator stores phase in the global convention (see effect-common.glsl:484:
  // shifting the signal by +Δt adds +2π·f·Δt uniformly to every atom's phase).
  // An impulse at absolute time T has phase -2π·f·T at every atom (t_c, f_c)
  // within the synthesis support — no pixel-time dependence.
  float targetPhase = -TWO_PI * fHz * bandAnchor;

  float curL = getPhase(sourceTexel.rg);
  float curR = getPhase(sourceTexel.ba);
  float newL = curL + blend * unwrapPhase(targetPhase - curL);
  float newR = curR + blend * unwrapPhase(targetPhase - curR);

  return vec4(fromPolar(magL, newL), fromPolar(magR, newR));
}
