#include "effect-common.glsl"
#include "edge-mode.glsl"

uniform sampler2D convolveIrTex;
uniform sampler2D convolveIrMetadataTex;
uniform float     convolveIrFrameCount;
uniform float     convolveIrBandCount;
uniform float     convolveIrMinFreq;
uniform float     convolveIrBandsPerOctave;
uniform bool      convolveIrEnabled;
uniform int       convolveIrSize;
uniform int       convolveEdgeMode;
uniform Parameter convolveIrTimeOffset;
uniform Parameter convolveIrPitchShiftSemi;
uniform Parameter convolveIrRate;
uniform Parameter convolveGain;

void main() {
  ProcessingUvs coords = getProcessingUvs(vUv);
  vec4 originalTexel = texture(destSpectrogramTex, vUv);
  float audioLevelDb = getAudioLevelDb(coords.dest);
  vec2 weight = getBrushWeight(coords.dest, audioLevelDb);

  if ((weight.x <= 0.0 && weight.y <= 0.0) || !convolveIrEnabled || convolveIrFrameCount <= 0.0) {
    outColor = originalTexel;
    return;
  }

  // Convolution parameters drive tap geometry shared by both channels; keep mono.
  vec2 mods[NUM_MODULATORS];
  sampleModulators(mods);
  float irTimeOff = applyModulationCachedMono(
    convolveIrTimeOffset.value, convolveIrTimeOffset.minValue, convolveIrTimeOffset.maxValue,
    convolveIrTimeOffset.modulationAmounts, convolveIrTimeOffset.contextualModAmounts, convolveIrTimeOffset.macroAmounts,
    mods
  );
  float irPitchShiftSemi = applyModulationCachedMono(
    convolveIrPitchShiftSemi.value, convolveIrPitchShiftSemi.minValue, convolveIrPitchShiftSemi.maxValue,
    convolveIrPitchShiftSemi.modulationAmounts, convolveIrPitchShiftSemi.contextualModAmounts, convolveIrPitchShiftSemi.macroAmounts,
    mods
  );
  float rate = applyModulationCachedMono(
    convolveIrRate.value, convolveIrRate.minValue, convolveIrRate.maxValue,
    convolveIrRate.modulationAmounts, convolveIrRate.contextualModAmounts, convolveIrRate.macroAmounts,
    mods
  );
  float gain = applyModulationCachedMono(
    convolveGain.value, convolveGain.minValue, convolveGain.maxValue,
    convolveGain.modulationAmounts, convolveGain.contextualModAmounts, convolveGain.macroAmounts,
    mods
  );

  // ---- Hoisted band metadata ------------------------------------------------
  // gaborator: each band has its own time resolution. We must iterate one tap per
  // BAND-LOCAL frame, otherwise low-freq bands read the same frame many times in
  // a row and get scaled up by their time-scale factor.
  float srcBandIndex = floor((1.0 - coords.source.y) * sourceBandCount);
  vec4  srcMeta = fetchBandMetadata(sourceMetadataTex, srcBandIndex);
  float srcBandStart     = srcMeta.r;
  float srcBandLength    = srcMeta.g;
  float srcBandTimeScale = exp2(srcMeta.b);
  ivec2 srcTexSize = textureSize(sourceSpectrogramTex, 0);
  float srcTexWidthF = float(max(srcTexSize.x, 1));
  int   srcMaxPx = max(srcTexSize.x - 1, 0);
  int   srcMaxPy = max(srcTexSize.y - 1, 0);

  // Map dest Hz -> IR band so IRs analyzed with a different minFreq / bpo still
  // filter at matching absolute frequencies (proportional y lookup gives wrong
  // bands when the IR has a different layout). Positive pitch shift reads LOWER
  // IR frequencies so that content plays back sounding higher — since gaborator
  // stores band 0 = highest freq and band N-1 = lowest, that is a POSITIVE
  // delta on the band index.
  float fDest = max(getDestMetadata(coords.dest).a, 1e-6);
  float irBandAtFout = (convolveIrBandCount - 1.0)
                     - convolveIrBandsPerOctave * log2(fDest / max(convolveIrMinFreq, 1e-6));
  float irBandIndexF = irBandAtFout + (convolveIrBandsPerOctave / 12.0) * irPitchShiftSemi;
  float irBandIndex = clamp(irBandIndexF, 0.0, convolveIrBandCount - 1.0);
  vec4  irMeta = fetchBandMetadata(convolveIrMetadataTex, irBandIndex);
  float irBandStart     = irMeta.r;
  float irBandLength    = irMeta.g;
  float irBandTimeScale = exp2(irMeta.b);
  ivec2 irTexSize = textureSize(convolveIrTex, 0);
  float irTexWidthF = float(max(irTexSize.x, 1));
  int   irMaxPx = max(irTexSize.x - 1, 0);
  int   irMaxPy = max(irTexSize.y - 1, 0);

  // IR base position in band-local units. The source per-tap position is
  // derived inside the loop via the dest-UV formulation so the brush edge mode
  // can rewrite it; no separate srcBaseBandIdx needed.
  float irBaseBandIdx = (irTimeOff * convolveIrFrameCount) / irBandTimeScale;

  int effectiveTaps = int(min(float(convolveIrSize), irBandLength));

  vec2 accumL = vec2(0.0);
  vec2 accumR = vec2(0.0);

  // rate controls how the source advances per tap, measured in REAL TIME:
  //   rate =  1: forward reverb at normal speed (one IR-tap of real time into the past per step)
  //   rate = -1: reverse reverb at normal speed (one IR-tap of real time into the future)
  //   |rate|>1 stretches tail in time; |rate|<1 compresses; 0 is a scalar filter.
  // One IR tap covers irBandTimeScale real frames. Expressed in dest UV that's:
  //   destUvStepPerTap = rate * irBandTimeScale / (sourceFrameCount * sourceTimeScale)
  // From any tap's dest-UV-x we can recover its source-UV-x via the identity
  //   effSourceUvX = coords.source.x + (effDestUvX - coords.dest.x) * sourceTimeScale
  // (source/dest offsets + modulation cancel because they don't depend on k).
  // This matches the naive band-local formulation when no edge remap happens,
  // but also lets the brush edge mode rewrite effDestUvX inside the brush.
  float destUvStepPerTap = rate * irBandTimeScale
                         / max(sourceFrameCount * max(sourceTimeScale, 1e-6), 1e-6);

  // Global wrapMode handles reads that exit file bounds (useful for seamless
  // loops). convolveEdgeMode handles reads that exit the BRUSH but stay in-file.
  // Clamping to the file edge would turn every past-start tap into source[0]
  // and convolve that into the IR, producing a bogus impulse at t=0 that rings
  // out the tail — zero-pad instead. IR reads always zero-pad: an IR is finite
  // and wrapping it is meaningless.
  bool wrapSrcTime = (wrapMode == 1 || wrapMode == 3);

  // IR always reads forward (tap k → IR frame k + 0.5).
  for (int k = 0; k < 512; k++) {
    if (k >= effectiveTaps) break;

    // --- Brush edge mode (X axis only; convolve doesn't step across bands). --
    float tapDestUvX = coords.dest.x - destUvStepPerTap * float(k);
    float localX = tapDestUvX - brushBottomLeftUv.x;
    bool tapZero, tapInvert;
    float newLocalX = applyEdgeModeAxis(localX, brushSizeUv.x, convolveEdgeMode, tapZero, tapInvert);
    if (tapZero) continue;

    // Cut / Bleed / Invert don't relocate the sample (Invert just negates the
    // contribution below). Wrap / Clamp / Reflect move the read back inside
    // the brush in dest UV space.
    float effDestUvX = (convolveEdgeMode == 0 || convolveEdgeMode == 1 || convolveEdgeMode == 5)
                     ? tapDestUvX
                     : (brushBottomLeftUv.x + newLocalX);
    float effSourceUvX = coords.source.x + (effDestUvX - coords.dest.x) * sourceTimeScale;
    float srcBandIdxF = effSourceUvX * sourceFrameCount / max(srcBandTimeScale, 1e-6);

    // --- File-bounds / global wrap on the source index. ----------------------
    float srcIdxFloor = floor(srcBandIdxF);
    float srcIdx;
    bool srcInBounds;
    if (wrapSrcTime) {
      srcIdx = mod(srcIdxFloor, srcBandLength);
      if (srcIdx < 0.0) srcIdx += srcBandLength;
      srcInBounds = true;
    } else {
      srcIdx = srcIdxFloor;
      srcInBounds = (srcIdxFloor >= 0.0) && (srcIdxFloor < srcBandLength);
    }

    float irBandIdxF = irBaseBandIdx + float(k) + 0.5;
    float irIdxFloor = floor(irBandIdxF);
    bool irInBounds = (irIdxFloor >= 0.0) && (irIdxFloor < irBandLength);

    if (!srcInBounds || !irInBounds) continue;

    float srcPixel = srcBandStart + srcIdx;
    int srcPx = clamp(int(mod(srcPixel, srcTexWidthF)), 0, srcMaxPx);
    int srcPy = clamp(int(floor(srcPixel / srcTexWidthF)), 0, srcMaxPy);
    vec4 srcTexel = texelFetch(sourceSpectrogramTex, ivec2(srcPx, srcPy), 0);

    float irPixel = irBandStart + irIdxFloor;
    int irPx = clamp(int(mod(irPixel, irTexWidthF)), 0, irMaxPx);
    int irPy = clamp(int(floor(irPixel / irTexWidthF)), 0, irMaxPy);
    vec4 irTexel = texelFetch(convolveIrTex, ivec2(irPx, irPy), 0);

    float magL = srcTexel.x * irTexel.x;
    float phsL = srcTexel.y + irTexel.y;
    float magR = srcTexel.z * irTexel.z;
    float phsR = srcTexel.w + irTexel.w;

    float tapSign = tapInvert ? -1.0 : 1.0;
    accumL += tapSign * magL * vec2(cos(phsL), sin(phsL));
    accumR += tapSign * magR * vec2(cos(phsR), sin(phsR));
  }

  float outMagL = length(accumL) * gain;
  float outPhsL = accumL == vec2(0.0) ? 0.0 : atan(accumL.y, accumL.x);
  float outMagR = length(accumR) * gain;
  float outPhsR = accumR == vec2(0.0) ? 0.0 : atan(accumR.y, accumR.x);

  vec4 wetTexel = vec4(
    fromPolar(outMagL, outPhsL),
    fromPolar(outMagR, outPhsR)
  );
  wetTexel.rg = limitMagnitude(wetTexel.rg);
  wetTexel.ba = limitMagnitude(wetTexel.ba);

  outColor = applyBrush(originalTexel, wetTexel, weight, coords.dest, vUv);
}
