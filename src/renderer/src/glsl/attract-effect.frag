#include "effect-common.glsl"

// Attract pulls energy across the time-frequency plane toward a map: the
// field's loud content, the notes of the scale, the snap grid, or a
// modulator's own field. Runs as two passes (pitch axis, then time axis),
// each a conservation-correct basin
// gather: every bin's energy relocates by its own kernel-weighted pull, and
// each output bin sums the complex contributions that land on it with their
// phase re-based for the move. Repeated strokes are mean-shift iterations
// that settle at basin modes, where zero pull makes the gather an identity.

uniform int attractMap;    // 0=Source, 1=Scale, 2=Grid, 3/4/5=Modulator 1-3
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
// Gather taps per side for the continuous field maps (Source, Modulator).
// The field magnitudes every contributor's centroid needs lie on one shared
// lattice at the gather spacing, sampled once per fragment; the lattice spans
// the gather taps plus the kernel reach either side.
const int   ATTRACT_FIELD_HALF = 12;
const int   ATTRACT_LATTICE_HALF = 2 * ATTRACT_FIELD_HALF + 1;
const int   ATTRACT_LATTICE = 2 * ATTRACT_LATTICE_HALF + 1;
const float ATTRACT_C0_HZ = 16.3516;

// Kernel weight for a normalized distance u = |d| / smooth: a linear valley
// whose pull fades to zero one smooth from the floor.
float attractKernelWeight(float u) {
  return max(1.0 - u, 0.0);
}

// Packed read with the band's metadata already in hand, so repeated reads on
// one band pay a single texel fetch each instead of a metadata fetch too.
vec4 attractPackedRead(sampler2D dataTex, vec4 meta, float xUv, float frameCount) {
  float timeIndex = clamp(floor(clamp(xUv, 0.0, 1.0) * frameCount / exp2(meta.b)), 0.0, meta.g - 1.0);
  ivec2 texSize = textureSize(dataTex, 0);
  float widthF = float(max(texSize.x, 1));
  float linearIndex = meta.r + timeIndex;
  int px = clamp(int(mod(linearIndex, widthF)), 0, max(texSize.x - 1, 0));
  int py = clamp(int(floor(linearIndex / widthF)), 0, max(texSize.y - 1, 0));
  return texelFetch(dataTex, ivec2(px, py), 0);
}

// Coefficient time in seconds at a dest position: dyadic bands store one
// coefficient per 2^step frames, anchored at the bin's left edge.
float attractCoeffTimeSec(float xUv, float stepExp) {
  float strideFrames = exp2(stepExp);
  return floor(xUv * destFrameCount / strideFrames) * strideFrames / max(destSampleRate, 1e-6);
}

// Magnitude of the picked file's spectrogram at an absolute (time UV,
// frequency Hz) position.
float attractFileFieldMag(float xUv, float fHz) {
  float idx = (attractFieldBands - 1.0)
            - attractFieldBpo * log2(max(fHz, 1e-6) / max(attractFieldMinFreq, 1e-6));
  if (xUv < 0.0 || xUv > 1.0 || idx < 0.0 || idx > attractFieldBands - 1.0) return 0.0;
  vec4 t = readPackedData(vec2(xUv, 1.0 - (idx + 0.5) / attractFieldBands),
                          attractFieldTex, attractFieldMetaTex, attractFieldFrames, attractFieldBands);
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

// Mass of a modulator's field at a dest position. The precomputed modulator
// textures share the packed spectrogram layout, so the read uses the band's
// metadata; the stereo lanes average to a mono field.
float attractModFieldMag(vec4 meta, float xUv) {
  if (attractMap == 5) {
    vec4 t = attractPackedRead(modulatorTex1, meta, xUv, destFrameCount);
    return max(0.5 * (t.x + t.y), 0.0);
  }
  vec4 t = attractPackedRead(modulatorTex0, meta, xUv, destFrameCount);
  return attractMap == 3 ? max(0.5 * (t.x + t.y), 0.0) : max(0.5 * (t.z + t.w), 0.0);
}

// Deviation of a band's instantaneous frequency from its center, in Hz,
// measured from the canvas phase steps around x. The center phase comes from
// the texel already read.
float attractDevHz(vec4 meta, float xUv, float pCenter, float strideUv, float dtSec) {
  float p0 = attractPackedRead(destSpectrogramTex, meta, xUv - strideUv, destFrameCount).y;
  float p2 = attractPackedRead(destSpectrogramTex, meta, xUv + strideUv, destFrameCount).y;
  return instFreqDevHz(p0, pCenter, p2, dtSec);
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
  float safeBrushY = max(EPSILON, brushSizeUv.y);

  vec4 destMeta = getDestMetadata(destUv);
  float fcDest = max(destMeta.a, 1e-6);
  float myBand = floor((1.0 - destUv.y) * destBandCount);

  vec2 accL = vec2(0.0);
  vec2 accR = vec2(0.0);
  float energyL = 0.0;
  float energyR = 0.0;

  if (attractAxis == 0) {
    // ---- Pitch pass: gather bands whose pulled energy lands on this band.
    if (abs(amountY) < 1e-4) {
      outColor = originalTexel;
      return;
    }
    float windowSemis = min(3.0 * max(smoothYSemis, 1e-4), 24.0);
    float windowBands = windowSemis * bandsPerSemi;
    bool fieldMap = attractMap == 0 || attractMap >= 3;
    int halfTaps = fieldMap ? ATTRACT_FIELD_HALF : ATTRACT_BANDS_MAX;
    int stride = max(1, int(ceil(windowBands / float(halfTaps))));
    float stepSemis = float(stride) / bandsPerSemi;
    int iMax = min(halfTaps + 1, int(windowBands / float(stride)) + 1);
    float tD = attractCoeffTimeSec(destUv.x, destMeta.b);
    float tAnchorSec = anchorUvX * destFrameCount / max(destSampleRate, 1e-6);

    float fieldMag[ATTRACT_LATTICE];
    int mHalf = 0;
    float uPerTapY = stepSemis / max(smoothYSemis, 1e-4);
    if (fieldMap) {
      // The kernel's support ends at one smooth from the center.
      mHalf = min(ATTRACT_FIELD_HALF, int(ceil(max(smoothYSemis, 1e-4) / stepSemis)));
      int nMax = iMax + mHalf;
      for (int n = -nMax; n <= nMax; n++) {
        float b = myBand + float(n * stride);
        float mag = 0.0;
        if (b >= 0.0 && b < destBandCount) {
          if (attractMap == 0 && attractFieldMode == 1) {
            float fHz = destMinFreq * exp2((destBandCount - 1.0 - b) / destBandsPerOctave);
            mag = attractFileFieldMag(destUv.x, fHz);
          } else {
            vec4 bMeta = getDestMetadata(vec2(destUv.x, 1.0 - (b + 0.5) / destBandCount));
            if (attractMap >= 3) {
              mag = attractModFieldMag(bMeta, destUv.x);
            } else {
              vec4 t = attractPackedRead(destSpectrogramTex, bMeta, destUv.x, destFrameCount);
              mag = getMag(t.rg) + getMag(t.ba);
            }
          }
        }
        fieldMag[n + ATTRACT_LATTICE_HALF] = mag;
      }
    }

    for (int i = -iMax; i <= iMax; i++) {
      float j = myBand + float(i * stride);
      if (j < 0.0 || j >= destBandCount) continue;
      vec2 jUv = vec2(destUv.x, 1.0 - (j + 0.5) / destBandCount);

      if (fieldMap) {
        // Pull for band j from the shared lattice, in semitones (positive =
        // up in pitch); pure ALU, so taps that miss this output bin skip
        // every texture read.
        float sum = 0.0;
        float wsum = 0.0;
        for (int m = -mHalf; m <= mHalf; m++) {
          float w = max(1.0 - abs(float(m)) * uPerTapY, 0.0)
                  * fieldMag[(i - m) + ATTRACT_LATTICE_HALF];
          sum += w * (float(m) * stepSemis);
          wsum += w;
        }
        float pullSemis = wsum > 1e-9 ? sum / wsum : 0.0;

        // Landings beyond the gather window are never collected, so clamp.
        float dispSemis = clamp(pullSemis * amountY, -windowSemis, windowSemis);
        float landBand = j - dispSemis * bandsPerSemi;
        float hat = 1.0 - abs(landBand - myBand) / max(float(stride), 1.0);
        if (hat <= 0.0) continue;

        vec2 jOff = getEffectiveBrushOffset(jUv);
        if (jOff.y < 0.0 || jOff.y > safeBrushY) continue;
        vec4 jMeta = getDestMetadata(jUv);
        float localX;
        if (getBrushTimeCoverage(jUv, jMeta, localX) <= 0.0) continue;
        vec4 jTexel = attractPackedRead(destSpectrogramTex, jMeta, destUv.x, destFrameCount);
        if (getMag(jTexel.rg) + getMag(jTexel.ba) < 1e-7) continue;

        float fcJ = max(jMeta.a, 1e-6);
        float dtJ = exp2(jMeta.b) / max(destSampleRate, 1e-6);
        float strideJUv = exp2(jMeta.b) / max(destFrameCount, 1.0);
        float devJ = attractDevHz(jMeta, destUv.x, jTexel.y, strideJUv, dtJ);
        float fTrueJ = fcJ + clamp(devJ, -FREQ_DEV_CLAMP * fcJ, FREQ_DEV_CLAMP * fcJ);

        // Carrier re-base for the band move, evaluated at each band's own
        // dyadic coefficient time: detrend swap at tJ, retune ramp from the
        // brush anchor, then extrapolation from tJ to this band's coefficient
        // time at the landed frequency.
        float tJ = attractCoeffTimeSec(destUv.x, jMeta.b);
        float fTargetHz = fTrueJ * exp2(dispSemis / 12.0);
        float phaseAdd = carrierRebase(fcJ, fcDest, tJ)
                       + contentAdvance(fTargetHz, fTrueJ, tJ - tAnchorSec)
                       + contentAdvance(fTargetHz, fcDest, tD - tJ);

        accL += toComplex(vec2(getMag(jTexel.rg) * hat, jTexel.g + phaseAdd));
        accR += toComplex(vec2(getMag(jTexel.ba) * hat, jTexel.a + phaseAdd));
      } else {
        // Comb pull needs the band's measured frequency, so the reads come
        // first here.
        vec2 jOff = getEffectiveBrushOffset(jUv);
        if (jOff.y < 0.0 || jOff.y > safeBrushY) continue;
        vec4 jMeta = getDestMetadata(jUv);
        float localX;
        if (getBrushTimeCoverage(jUv, jMeta, localX) <= 0.0) continue;
        vec4 jTexel = attractPackedRead(destSpectrogramTex, jMeta, destUv.x, destFrameCount);
        if (getMag(jTexel.rg) + getMag(jTexel.ba) < 1e-7) continue;

        float fcJ = max(jMeta.a, 1e-6);
        float dtJ = exp2(jMeta.b) / max(destSampleRate, 1e-6);
        float strideJUv = exp2(jMeta.b) / max(destFrameCount, 1.0);
        float devJ = attractDevHz(jMeta, destUv.x, jTexel.y, strideJUv, dtJ);
        float fTrueJ = fcJ + clamp(devJ, -FREQ_DEV_CLAMP * fcJ, FREQ_DEV_CLAMP * fcJ);

        float absSemis = 12.0 * log2(fTrueJ / ATTRACT_C0_HZ);
        float pullSemis = attractCombPullSemis(absSemis, smoothYSemis);

        float dispSemis = clamp(pullSemis * amountY, -windowSemis, windowSemis);
        float landBand = j - dispSemis * bandsPerSemi;
        float hat = 1.0 - abs(landBand - myBand) / max(float(stride), 1.0);
        if (hat <= 0.0) continue;

        float tJ = attractCoeffTimeSec(destUv.x, jMeta.b);
        float fTargetHz = fTrueJ * exp2(dispSemis / 12.0);
        float phaseAdd = carrierRebase(fcJ, fcDest, tJ)
                       + contentAdvance(fTargetHz, fTrueJ, tJ - tAnchorSec)
                       + contentAdvance(fTargetHz, fcDest, tD - tJ);

        accL += toComplex(vec2(getMag(jTexel.rg) * hat, jTexel.g + phaseAdd));
        accR += toComplex(vec2(getMag(jTexel.ba) * hat, jTexel.a + phaseAdd));
      }
    }
  } else {
    // ---- Time pass: gather time bins of this band whose energy lands here.
    // The Scale map has no time lattice, so the pass runs for the field maps
    // and for Grid when a beat size is known.
    bool timeMapValid = (attractMap == 0) || attractMap >= 3 || (attractMap == 2 && attractUvPerBeat > 1e-6);
    if (abs(amountX) < 1e-4 || !timeMapValid) {
      outColor = originalTexel;
      return;
    }
    float strideUv = exp2(destMeta.b) / max(destFrameCount, 1.0);
    float smoothXUv = max(smoothXBeats * attractUvPerBeat, strideUv);
    float windowUv = 3.0 * smoothXUv;
    bool fieldMap = attractMap == 0 || attractMap >= 3;
    // Tap spacing follows each band's own coefficient stride; a shared
    // lattice would quantize fine high-band landings.
    int halfTaps = fieldMap ? ATTRACT_FIELD_HALF : ATTRACT_TIME_MAX;
    int strideT = max(1, int(ceil(windowUv / (strideUv * float(halfTaps)))));
    float tapUv = strideUv * float(strideT);
    int iMax = min(halfTaps + 1, int((windowUv + strideUv) / tapUv));
    float uvPerTooth = attractUvPerBeat * max(attractGridBeats, 1e-6);
    float tDCoeff = attractCoeffTimeSec(destUv.x, destMeta.b);

    float fieldMag[ATTRACT_LATTICE];
    int mHalf = 0;
    float uPerTapX = tapUv / max(smoothXUv, 1e-6);
    if (fieldMap) {
      mHalf = min(ATTRACT_FIELD_HALF, int(ceil(smoothXUv / tapUv)));
      float fileIdx = (attractFieldBands - 1.0)
                    - attractFieldBpo * log2(fcDest / max(attractFieldMinFreq, 1e-6));
      bool fileInRange = fileIdx >= 0.0 && fileIdx <= attractFieldBands - 1.0;
      vec4 fieldMeta = fetchBandMetadata(attractFieldMetaTex, fileIdx + 0.5);
      int nMax = iMax + mHalf;
      for (int n = -nMax; n <= nMax; n++) {
        float xn = destUv.x + float(n) * tapUv;
        float mag = 0.0;
        if (xn >= 0.0 && xn <= 1.0) {
          if (attractMap >= 3) {
            mag = attractModFieldMag(destMeta, xn);
          } else if (attractFieldMode == 1) {
            if (fileInRange) {
              vec4 t = attractPackedRead(attractFieldTex, fieldMeta, xn, attractFieldFrames);
              mag = getMag(t.rg) + getMag(t.ba);
            }
          } else {
            vec4 t = attractPackedRead(destSpectrogramTex, destMeta, xn, destFrameCount);
            mag = getMag(t.rg) + getMag(t.ba);
          }
        }
        fieldMag[n + ATTRACT_LATTICE_HALF] = mag;
      }
    }

    for (int i = -iMax; i <= iMax; i++) {
      float dxUv = float(i) * tapUv;
      vec2 jUv = vec2(destUv.x + dxUv, destUv.y);
      if (jUv.x < 0.0 || jUv.x > 1.0) continue;

      // Both time pulls are texture-free — the field pull reads the shared
      // lattice — so taps that miss this output bin cost only ALU.
      float pullUv;
      if (fieldMap) {
        float sum = 0.0;
        float wsum = 0.0;
        for (int m = -mHalf; m <= mHalf; m++) {
          float w = max(1.0 - abs(float(m)) * uPerTapX, 0.0)
                  * fieldMag[(i + m) + ATTRACT_LATTICE_HALF];
          sum += w * (float(m) * tapUv);
          wsum += w;
        }
        pullUv = wsum > 1e-9 ? sum / wsum : 0.0;
      } else {
        float tooth = floor(jUv.x / uvPerTooth + 0.5) * uvPerTooth;
        float d = tooth - jUv.x;
        pullUv = d * attractKernelWeight(abs(d) / max(smoothXUv, 1e-6));
      }

      float landUv = jUv.x + clamp(pullUv * amountX, -windowUv, windowUv);
      float hat = 1.0 - abs(landUv - destUv.x) / tapUv;
      if (hat <= 0.0) continue;

      float localX;
      if (getBrushTimeCoverage(jUv, destMeta, localX) <= 0.0) continue;
      vec4 jTexel = attractPackedRead(destSpectrogramTex, destMeta, jUv.x, destFrameCount);
      if (getMag(jTexel.rg) + getMag(jTexel.ba) < 1e-7) continue;

      // Time-move carrier correction at exact coefficient times: the moved
      // waveform keeps its absolute phase, and the new slot detrends by
      // fc * tD instead of fc * tJ.
      float tJ = attractCoeffTimeSec(jUv.x, destMeta.b);
      float phaseAdd = contentAdvance(0.0, fcDest, tDCoeff - tJ);

      // The tap lattice is anchored to this output, so the only two landings
      // that can take this contribution sit tapUv apart and carry weights hat
      // and 1 - hat. The pair conserves energy only after this normalisation.
      float splat = hat * inversesqrt(hat * hat + (1.0 - hat) * (1.0 - hat));
      float wMagL = getMag(jTexel.rg) * splat;
      float wMagR = getMag(jTexel.ba) * splat;
      accL += toComplex(vec2(wMagL, jTexel.g + phaseAdd));
      accR += toComplex(vec2(wMagR, jTexel.a + phaseAdd));
      energyL += wMagL * wMagL;
      energyR += wMagR * wMagR;
    }
  }

  vec2 polL = accL == vec2(0.0) ? vec2(0.0) : polarFromComplex(accL);
  vec2 polR = accR == vec2(0.0) ? vec2(0.0) : polarFromComplex(accR);
  // The time pass takes its magnitude from the energy sum: merged
  // contributions from different origin times interfere at 2*PI*fc*dt in the
  // complex sum, which would comb the spectrum; the complex sum only supplies
  // the phase.
  if (attractAxis == 1) {
    polL = energyL > 0.0 ? vec2(sqrt(energyL), polL.y) : vec2(0.0);
    polR = energyR > 0.0 ? vec2(sqrt(energyR), polR.y) : vec2(0.0);
  }
  vec4 resultTexel = vec4(limitMagnitude(polL), limitMagnitude(polR));

  outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);

  if (any(isnan(outColor)) || any(isinf(outColor))) {
    outColor = originalTexel;
  }
}
