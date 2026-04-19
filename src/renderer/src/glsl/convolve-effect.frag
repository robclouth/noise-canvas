#include "effect-common.glsl"

uniform sampler2D convolveIrTex;
uniform sampler2D convolveIrMetadataTex;
uniform float     convolveIrFrameCount;
uniform float     convolveIrBandCount;
uniform vec2      convolveIrTextureSize;
uniform bool      convolveIrEnabled;
uniform int       convolveIrSize;
uniform Parameter convolveIrTimeOffset;
uniform Parameter convolveIrPitchShiftBands;
uniform Parameter convolveIrRate;
uniform Parameter convolveGain;

void main() {
  ProcessingUvs coords = getProcessingUvs(vUv);
  vec4 originalTexel = texture(destSpectrogramTex, vUv);
  float audioLevelDb = getAudioLevelDb(coords.dest);
  float weight = getBrushWeight(coords.dest, audioLevelDb);

  if (weight <= 0.0 || !convolveIrEnabled || convolveIrFrameCount <= 0.0) {
    outColor = originalTexel;
    return;
  }

  float irTimeOff = applyModulation(
    convolveIrTimeOffset.value, convolveIrTimeOffset.minValue, convolveIrTimeOffset.maxValue,
    convolveIrTimeOffset.modulationAmounts, convolveIrTimeOffset.contextualModAmounts, convolveIrTimeOffset.macroAmounts,
    coords.dest, 0, audioLevelDb
  );
  float irPitchShiftBands = applyModulation(
    convolveIrPitchShiftBands.value, convolveIrPitchShiftBands.minValue, convolveIrPitchShiftBands.maxValue,
    convolveIrPitchShiftBands.modulationAmounts, convolveIrPitchShiftBands.contextualModAmounts, convolveIrPitchShiftBands.macroAmounts,
    coords.dest, 0, audioLevelDb
  );
  float rate = applyModulation(
    convolveIrRate.value, convolveIrRate.minValue, convolveIrRate.maxValue,
    convolveIrRate.modulationAmounts, convolveIrRate.contextualModAmounts, convolveIrRate.macroAmounts,
    coords.dest, 0, audioLevelDb
  );
  float gain = applyModulation(
    convolveGain.value, convolveGain.minValue, convolveGain.maxValue,
    convolveGain.modulationAmounts, convolveGain.contextualModAmounts, convolveGain.macroAmounts,
    coords.dest, 0, audioLevelDb
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

  // Pitch shift applied to IR band index (up-shift = read higher-freq IR content
  // for this output freq). Clamp to available IR bands.
  float irBandIndexF = floor((1.0 - coords.dest.y) * convolveIrBandCount) + irPitchShiftBands;
  float irBandIndex = clamp(irBandIndexF, 0.0, convolveIrBandCount - 1.0);
  vec4  irMeta = fetchBandMetadata(convolveIrMetadataTex, irBandIndex);
  float irBandStart     = irMeta.r;
  float irBandLength    = irMeta.g;
  float irBandTimeScale = exp2(irMeta.b);
  ivec2 irTexSize = textureSize(convolveIrTex, 0);
  float irTexWidthF = float(max(irTexSize.x, 1));
  int   irMaxPx = max(irTexSize.x - 1, 0);
  int   irMaxPy = max(irTexSize.y - 1, 0);

  // Band-local starting positions (source and IR).
  float srcBaseBandIdx = (coords.source.x * sourceFrameCount) / srcBandTimeScale;
  float irBaseBandIdx  = (irTimeOff * convolveIrFrameCount) / irBandTimeScale;

  int effectiveTaps = int(min(float(convolveIrSize), irBandLength));

  vec2 accumL = vec2(0.0);
  vec2 accumR = vec2(0.0);

  // rate controls how the source advances per tap:
  //   rate =  1: srcIdx steps -1 per tap (past) → forward reverb at normal speed
  //   rate = -1: srcIdx steps +1 per tap (future) → reverse reverb at normal speed
  //   |rate|>1 stretches tail in time; |rate|<1 compresses; 0 is a scalar filter.
  // IR always reads forward (tap k → IR frame k + 0.5).
  for (int k = 0; k < 512; k++) {
    if (k >= effectiveTaps) break;

    float srcBandIdxF = srcBaseBandIdx - rate * float(k);
    float srcIdx = clamp(floor(srcBandIdxF), 0.0, srcBandLength - 1.0);
    float srcPixel = srcBandStart + srcIdx;
    int srcPx = clamp(int(mod(srcPixel, srcTexWidthF)), 0, srcMaxPx);
    int srcPy = clamp(int(floor(srcPixel / srcTexWidthF)), 0, srcMaxPy);
    vec4 srcTexel = texelFetch(sourceSpectrogramTex, ivec2(srcPx, srcPy), 0);

    float irBandIdxF = irBaseBandIdx + float(k) + 0.5;
    float irIdx = clamp(floor(irBandIdxF), 0.0, irBandLength - 1.0);
    float irPixel = irBandStart + irIdx;
    int irPx = clamp(int(mod(irPixel, irTexWidthF)), 0, irMaxPx);
    int irPy = clamp(int(floor(irPixel / irTexWidthF)), 0, irMaxPy);
    vec4 irTexel = texelFetch(convolveIrTex, ivec2(irPx, irPy), 0);

    float magL = srcTexel.x * irTexel.x;
    float phsL = srcTexel.y + irTexel.y;
    float magR = srcTexel.z * irTexel.z;
    float phsR = srcTexel.w + irTexel.w;

    accumL += magL * vec2(cos(phsL), sin(phsL));
    accumR += magR * vec2(cos(phsR), sin(phsR));
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
