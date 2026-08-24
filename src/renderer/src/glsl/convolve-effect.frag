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
uniform Parameter convolveGainDb;
uniform float     convolveIrNormScale;

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

  if ((weight.x <= 0.0 && weight.y <= 0.0) || !convolveIrEnabled || convolveIrFrameCount <= 0.0) {
    outColor = originalTexel;
    return;
  }

  // Convolution parameters drive tap geometry shared by both channels; keep mono.
  vec2 mods[NUM_MODULATORS];
  sampleModulators(mods);
  float irTimeOff = resolveParameterMono(convolveIrTimeOffset, mods);
  float irPitchShiftSemi = resolveParameterMono(convolveIrPitchShiftSemi, mods);
  float rate = resolveParameterMono(convolveIrRate, mods);
  float gain = pow(10.0, resolveParameterMono(convolveGainDb, mods) / 20.0);

  // ---- Hoisted band metadata ------------------------------------------------
  // gaborator: each band has its own time resolution. We must iterate one tap per
  // BAND-LOCAL frame, otherwise low-freq bands read the same frame many times in
  // a row and get scaled up by their time-scale factor.
  float srcBandIndex = floor((1.0 - coords.source.y) * sourceBandCount);
  PackedBand srcBand = fetchPackedBand(sourceMetadataTex, srcBandIndex);
  float srcBandStart     = srcBand.offset;
  float srcBandLength    = srcBand.fileLength;
  float srcBandTimeScale = exp2(srcBand.stepLog2);
  float srcFirstBin      = bandFirstBin(srcBand);
  ivec2 srcTexSize = textureSize(sourceSpectrogramTex, 0);

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
  PackedBand irBand = fetchPackedBand(convolveIrMetadataTex, irBandIndex);
  float irBandStart     = irBand.offset;
  float irBandLength    = irBand.fileLength;
  float irBandTimeScale = exp2(irBand.stepLog2);
  float irFirstBin      = bandFirstBin(irBand);
  ivec2 irTexSize = textureSize(convolveIrTex, 0);

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
    float localX = getEffectiveBrushOffset(vec2(tapDestUvX, coords.dest.y)).x;
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

    // Both textures may hold a window rather than the whole file, and a tap the
    // window misses is real audio, not silence — zero-padding it would quietly
    // shorten the convolution.
    float srcLocal = srcIdx - srcFirstBin;
    float irLocal = irIdxFloor - irFirstBin;
    bool srcResident = srcLocal >= 0.0 && srcLocal < srcBand.length;
    bool irResident = irLocal >= 0.0 && irLocal < irBand.length;

    vec4 srcTexel = markResidency(
      texelFetch(sourceSpectrogramTex, packedTexel(srcBandStart + srcLocal, srcTexSize), 0), srcResident);
    vec4 irTexel = markResidency(
      texelFetch(convolveIrTex, packedTexel(irBandStart + irLocal, irTexSize), 0), irResident);

    float magL = srcTexel.x * irTexel.x;
    float phsL = srcTexel.y + irTexel.y;
    float magR = srcTexel.z * irTexel.z;
    float phsR = srcTexel.w + irTexel.w;

    float tapSign = tapInvert ? -1.0 : 1.0;
    accumL += tapSign * magL * vec2(cos(phsL), sin(phsL));
    accumR += tapSign * magR * vec2(cos(phsR), sin(phsR));
  }

  float outMagL = length(accumL) * gain * convolveIrNormScale;
  float outPhsL = accumL == vec2(0.0) ? 0.0 : atan(accumL.y, accumL.x);
  float outMagR = length(accumR) * gain * convolveIrNormScale;
  float outPhsR = accumR == vec2(0.0) ? 0.0 : atan(accumR.y, accumR.x);

  vec4 wetTexel = vec4(
    fromPolar(outMagL, outPhsL),
    fromPolar(outMagR, outPhsR)
  );
  wetTexel.rg = limitMagnitude(wetTexel.rg);
  wetTexel.ba = limitMagnitude(wetTexel.ba);

  outColor = applyBrush(originalTexel, wetTexel, weight, coords.dest, vUv);
}
