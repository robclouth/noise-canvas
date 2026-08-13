#include "effect-common.glsl"

// Attract pulls energy across the time-frequency plane toward a map: the
// field's loud content, the notes of the scale, or the snap grid. Runs as two
// passes (pitch axis, then time axis), each a conservation-correct basin
// gather: every bin's energy relocates by its own kernel-weighted pull, and
// each output bin sums the complex contributions that land on it with their
// phase re-based for the move. Repeated strokes are mean-shift iterations
// that settle at basin modes, where zero pull makes the gather an identity.

uniform int attractMap;    // 0=Source, 1=Scale, 2=Grid
uniform int attractKernel; // 0=Gaussian, 1=Triangle, 2=Box, 3=Steps
uniform int attractAxis;   // 0=pitch pass, 1=time pass
uniform Parameter attractAmountX;
uniform Parameter attractAmountY;
uniform Parameter attractSmoothX; // beats, converted via attractUvPerBeat
uniform Parameter attractSmoothY; // semitones
uniform float attractScaleOffsets[12];
uniform float attractGridSemis;   // 0 = grid follows the scale
uniform float attractGridBeats;
uniform float attractUvPerBeat;
uniform int attractFieldMode;     // 0 = self (live canvas), 1 = picked file
uniform sampler2D attractFieldTex;
uniform sampler2D attractFieldMetaTex;
uniform float attractFieldFrames;
uniform float attractFieldBands;
uniform float attractFieldMinFreq;
uniform float attractFieldBpo;

const int   ATTRACT_BANDS_MAX = 32;
const int   ATTRACT_TIME_MAX = 64;
const int   ATTRACT_FIELD_TAPS = 8;
const float ATTRACT_C0_HZ = 16.3516;

// Kernel weight for a normalized distance u = |d| / smooth. The kernel is the
// valley's cross-section: it sets both how far the pull reaches and how the
// force ramps toward the floor.
float attractKernelWeight(float u) {
  if (u >= 1.0) return 0.0;
  if (attractKernel == 0) return exp(-4.5 * u * u);
  if (attractKernel == 1) return 1.0 - u;
  if (attractKernel == 2) return 1.0;
  return ceil((1.0 - u) * 3.0) / 3.0;
}

// Read the live canvas at an unpacked dest UV.
vec4 attractReadCanvas(vec2 unpackedUv) {
  vec2 uv = clamp(unpackedUv, vec2(0.0), vec2(1.0));
  return readPackedData(uv, destSpectrogramTex, destMetadataTex, destFrameCount, destBandCount);
}

// Coefficient time in seconds at a dest position: dyadic bands store one
// coefficient per 2^step frames, anchored at the bin's left edge.
float attractCoeffTimeSec(float xUv, float stepExp) {
  float strideFrames = exp2(stepExp);
  return floor(xUv * destFrameCount / strideFrames) * strideFrames / max(destSampleRate, 1e-6);
}

// Magnitude of the attractor field at an absolute (time UV, frequency Hz)
// position. Self mode reads the live canvas; file mode reads the picked
// file's spectrogram, matched by absolute frequency.
float attractFieldMagAtHz(float xUv, float fHz) {
  if (xUv < 0.0 || xUv > 1.0) return 0.0;
  if (attractFieldMode == 1) {
    float idx = (attractFieldBands - 1.0)
              - attractFieldBpo * log2(max(fHz, 1e-6) / max(attractFieldMinFreq, 1e-6));
    if (idx < 0.0 || idx > attractFieldBands - 1.0) return 0.0;
    vec4 t = readPackedData(vec2(xUv, 1.0 - (idx + 0.5) / attractFieldBands),
                            attractFieldTex, attractFieldMetaTex, attractFieldFrames, attractFieldBands);
    return getMag(t.rg) + getMag(t.ba);
  }
  float idx = (destBandCount - 1.0)
            - destBandsPerOctave * log2(max(fHz, 1e-6) / max(destMinFreq, 1e-6));
  if (idx < 0.0 || idx > destBandCount - 1.0) return 0.0;
  vec4 t = attractReadCanvas(vec2(xUv, 1.0 - (idx + 0.5) / destBandCount));
  return getMag(t.rg) + getMag(t.ba);
}

float attractSnapToScale(float target) {
  float chromaLow = floor(target);
  float chromaHigh = chromaLow + 1.0;
  int pcLow = int(mod(chromaLow, 12.0));
  int pcHigh = int(mod(chromaHigh, 12.0));
  float candLow = chromaLow + attractScaleOffsets[pcLow];
  float candHigh = chromaHigh + attractScaleOffsets[pcHigh];
  return (abs(candLow - target) <= abs(candHigh - target)) ? candLow : candHigh;
}

// Comb pull in semitones for a pitch (abs semitones above C0) toward the
// nearest tooth of the active lattice.
float attractCombPullSemis(float absSemis, float smoothSemis) {
  float tooth;
  if (attractMap == 1 || attractGridSemis <= 0.0) {
    tooth = attractSnapToScale(absSemis);
  } else {
    tooth = floor(absSemis / attractGridSemis + 0.5) * attractGridSemis;
  }
  float d = tooth - absSemis;
  return d * attractKernelWeight(abs(d) / max(smoothSemis, 1e-4));
}

// Deviation of a band's instantaneous frequency from its center, in Hz,
// measured from the canvas phase steps around unpacked-UV x.
float attractDevHz(vec2 uv, float strideUv, float dtSec) {
  float p0 = attractReadCanvas(vec2(uv.x - strideUv, uv.y)).y;
  float p1 = attractReadCanvas(uv).y;
  float p2 = attractReadCanvas(vec2(uv.x + strideUv, uv.y)).y;
  float step1 = unwrapPhase(p1 - p0);
  float step2 = unwrapPhase(p2 - p1);
  return (step1 + step2) * 0.5 / (TWO_PI * dtSec);
}

// Whether a dest UV falls inside the brush footprint, cheap form.
bool attractInBrush(vec2 destUv) {
  vec2 off = getEffectiveBrushOffset(destUv);
  if (off.y < 0.0 || off.y > max(EPSILON, brushSizeUv.y)) return false;
  float localX;
  return getBrushTimeCoverage(destUv, getDestMetadata(destUv), localX) > 0.0;
}

void main() {
  vec2 destUv = packedToUnpackedUv(destInverseMapTex, vUv, destFrameCount, destBandCount);
  if (brushWeightIsZero(destUv)) {
    outColor = texture(destSpectrogramTex, vUv);
    return;
  }
  ProcessingUvs coords = getProcessingUvs(vUv);
  vec4 originalTexel = texture(destSpectrogramTex, vUv);
  float audioLevelDb = getAudioLevelDb(coords.dest);
  vec2 weight = getBrushWeight(coords.dest, audioLevelDb);
  if (weight.x <= 0.0 && weight.y <= 0.0) {
    outColor = originalTexel;
    return;
  }

  vec2 mods[NUM_MODULATORS];
  sampleModulators(mods);
  float amountX = applyModulationCachedMono(
    attractAmountX.value, attractAmountX.minValue, attractAmountX.maxValue,
    attractAmountX.modulationAmounts, attractAmountX.contextualModAmounts, attractAmountX.macroAmounts,
    mods) / 100.0;
  float amountY = applyModulationCachedMono(
    attractAmountY.value, attractAmountY.minValue, attractAmountY.maxValue,
    attractAmountY.modulationAmounts, attractAmountY.contextualModAmounts, attractAmountY.macroAmounts,
    mods) / 100.0;
  float smoothXBeats = applyModulationCachedMono(
    attractSmoothX.value, attractSmoothX.minValue, attractSmoothX.maxValue,
    attractSmoothX.modulationAmounts, attractSmoothX.contextualModAmounts, attractSmoothX.macroAmounts,
    mods);
  float smoothYSemis = applyModulationCachedMono(
    attractSmoothY.value, attractSmoothY.minValue, attractSmoothY.maxValue,
    attractSmoothY.modulationAmounts, attractSmoothY.contextualModAmounts, attractSmoothY.macroAmounts,
    mods);

  float bandsPerSemi = destBandsPerOctave / 12.0;
  float anchorUvX = destUv.x - getEffectiveBrushOffset(destUv).x;

  vec4 destMeta = getDestMetadata(destUv);
  float fcDest = max(destMeta.a, 1e-6);
  float myBand = floor((1.0 - destUv.y) * destBandCount);

  vec2 accL = vec2(0.0);
  vec2 accR = vec2(0.0);

  if (attractAxis == 0) {
    // ---- Pitch pass: gather bands whose pulled energy lands on this band.
    if (abs(amountY) < 1e-4) {
      outColor = originalTexel;
      return;
    }
    float windowSemis = min(3.0 * max(smoothYSemis, 1e-4), 24.0);
    float windowBands = windowSemis * bandsPerSemi;
    // Smaller budget for Source: it pays an inner field loop per contributor.
    int bandBudget = (attractMap == 0) ? 24 : 2 * ATTRACT_BANDS_MAX;
    int stride = max(1, int(ceil(2.0 * windowBands / float(bandBudget))));
    float tD = attractCoeffTimeSec(destUv.x, destMeta.b);
    float tAnchorSec = anchorUvX * destFrameCount / max(destSampleRate, 1e-6);

    for (int i = -ATTRACT_BANDS_MAX; i <= ATTRACT_BANDS_MAX; i++) {
      float j = myBand + float(i * stride);
      if (abs(float(i * stride)) > windowBands + float(stride)) continue;
      if (j < 0.0 || j >= destBandCount) continue;
      vec2 jUv = vec2(destUv.x, 1.0 - (j + 0.5) / destBandCount);
      if (!attractInBrush(jUv)) continue;

      vec4 jTexel = attractReadCanvas(jUv);
      if (getMag(jTexel.rg) + getMag(jTexel.ba) < 1e-7) continue;

      vec4 jMeta = getDestMetadata(jUv);
      float fcJ = max(jMeta.a, 1e-6);
      float dtJ = exp2(jMeta.b) / max(destSampleRate, 1e-6);
      float strideJUv = exp2(jMeta.b) / max(destFrameCount, 1.0);
      float devJ = attractDevHz(jUv, strideJUv, dtJ);
      float fTrueJ = fcJ + clamp(devJ, -0.06 * fcJ, 0.06 * fcJ);

      // Pull for band j, in semitones (positive = up in pitch).
      float pullSemis;
      if (attractMap == 0) {
        float stepSemis = windowSemis / float(ATTRACT_FIELD_TAPS);
        float sum = 0.0;
        float wsum = 0.0;
        for (int m = -ATTRACT_FIELD_TAPS; m <= ATTRACT_FIELD_TAPS; m++) {
          float dSemis = float(m) * stepSemis;
          float w = attractKernelWeight(abs(dSemis) / max(smoothYSemis, 1e-4))
                  * attractFieldMagAtHz(destUv.x, fcJ * exp2(dSemis / 12.0));
          sum += w * dSemis;
          wsum += w;
        }
        pullSemis = wsum > 1e-9 ? sum / wsum : 0.0;
      } else {
        float absSemis = 12.0 * log2(fTrueJ / ATTRACT_C0_HZ);
        pullSemis = attractCombPullSemis(absSemis, smoothYSemis);
      }

      // Landings beyond the gather window are never collected, so clamp.
      float dispSemis = clamp(pullSemis * amountY, -windowSemis, windowSemis);
      // Landing position of band j's energy, in band-index space (band index
      // increases downward in pitch).
      float landBand = j - dispSemis * bandsPerSemi;
      float hat = 1.0 - abs(landBand - myBand) / max(float(stride), 1.0);
      if (hat <= 0.0) continue;

      // Carrier re-base for the band move, evaluated at each band's own
      // dyadic coefficient time: detrend swap at tJ, retune ramp from the
      // brush anchor, then extrapolation from tJ to this band's coefficient
      // time at the landed frequency.
      float tJ = attractCoeffTimeSec(destUv.x, jMeta.b);
      float fTargetHz = fTrueJ * exp2(dispSemis / 12.0);
      float phaseAdd = TWO_PI * ((fcJ - fcDest) * tJ
                               + (fTargetHz - fTrueJ) * (tJ - tAnchorSec)
                               + (fTargetHz - fcDest) * (tD - tJ));

      accL += toComplex(vec2(getMag(jTexel.rg) * hat, jTexel.g + phaseAdd));
      accR += toComplex(vec2(getMag(jTexel.ba) * hat, jTexel.a + phaseAdd));
    }
  } else {
    // ---- Time pass: gather time bins of this band whose energy lands here.
    // The Scale map has no time lattice, so the pass only runs for Source and
    // for Grid when a beat size is known.
    bool timeMapValid = (attractMap == 0) || (attractMap == 2 && attractUvPerBeat > 1e-6);
    if (abs(amountX) < 1e-4 || !timeMapValid) {
      outColor = originalTexel;
      return;
    }
    float strideUv = exp2(destMeta.b) / max(destFrameCount, 1.0);
    float smoothXUv = max(smoothXBeats * attractUvPerBeat, strideUv);
    float windowUv = 3.0 * smoothXUv;
    // Tap spacing follows each band's own coefficient stride; a shared
    // lattice would quantize fine high-band landings.
    int tapBudget = (attractMap == 0) ? 24 : 2 * ATTRACT_TIME_MAX;
    int strideT = max(1, int(ceil(2.0 * windowUv / (strideUv * float(tapBudget)))));
    float uvPerTooth = attractUvPerBeat * max(attractGridBeats, 1e-6);

    for (int i = -ATTRACT_TIME_MAX; i <= ATTRACT_TIME_MAX; i++) {
      float dxUv = float(i * strideT) * strideUv;
      if (abs(dxUv) > windowUv + strideUv) continue;
      vec2 jUv = vec2(destUv.x + dxUv, destUv.y);
      if (jUv.x < 0.0 || jUv.x > 1.0) continue;
      if (!attractInBrush(jUv)) continue;

      vec4 jTexel = attractReadCanvas(jUv);
      if (getMag(jTexel.rg) + getMag(jTexel.ba) < 1e-7) continue;

      float pullUv;
      if (attractMap == 0) {
        float stepUv = windowUv / float(ATTRACT_FIELD_TAPS);
        float sum = 0.0;
        float wsum = 0.0;
        for (int m = -ATTRACT_FIELD_TAPS; m <= ATTRACT_FIELD_TAPS; m++) {
          float d2 = float(m) * stepUv;
          float w = attractKernelWeight(abs(d2) / max(smoothXUv, 1e-6))
                  * attractFieldMagAtHz(jUv.x + d2, fcDest);
          sum += w * d2;
          wsum += w;
        }
        pullUv = wsum > 1e-9 ? sum / wsum : 0.0;
      } else {
        float tooth = floor(jUv.x / uvPerTooth + 0.5) * uvPerTooth;
        float d = tooth - jUv.x;
        pullUv = d * attractKernelWeight(abs(d) / max(smoothXUv, 1e-6));
      }

      float landUv = jUv.x + clamp(pullUv * amountX, -windowUv, windowUv);
      float hat = 1.0 - abs(landUv - destUv.x) / (strideUv * float(strideT));
      if (hat <= 0.0) continue;

      // Time-move carrier correction at exact coefficient times: the moved
      // waveform keeps its absolute phase, and the new slot detrends by
      // fc * tD instead of fc * tJ.
      float tJ = attractCoeffTimeSec(jUv.x, destMeta.b);
      float tD = attractCoeffTimeSec(destUv.x, destMeta.b);
      float phaseAdd = -TWO_PI * fcDest * (tD - tJ);

      accL += toComplex(vec2(getMag(jTexel.rg) * hat, jTexel.g + phaseAdd));
      accR += toComplex(vec2(getMag(jTexel.ba) * hat, jTexel.a + phaseAdd));
    }
  }

  vec2 polL = accL == vec2(0.0) ? vec2(0.0) : polarFromComplex(accL);
  vec2 polR = accR == vec2(0.0) ? vec2(0.0) : polarFromComplex(accR);
  vec4 resultTexel = vec4(limitMagnitude(polL), limitMagnitude(polR));

  outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);

  if (any(isnan(outColor)) || any(isinf(outColor))) {
    outColor = originalTexel;
  }
}
