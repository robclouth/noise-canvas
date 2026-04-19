#include "effect-common.glsl"

uniform sampler2D convolveIrTex;
uniform sampler2D convolveIrMetadataTex;
uniform float     convolveIrFrameCount;
uniform float     convolveIrBandCount;
uniform vec2      convolveIrTextureSize;
uniform bool      convolveIrEnabled;
uniform int       convolveIrSize;
uniform int       convolveOrigin; // 0=Forwards (causal), 1=Middle, 2=Backwards (anti-causal)
uniform Parameter convolveIrTimeOffset;
uniform Parameter convolveIrPitchOffset;
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
    convolveIrTimeOffset.modulationAmounts, convolveIrTimeOffset.contextualModAmounts,
    coords.dest, 0, audioLevelDb
  );
  float irPitchOff = applyModulation(
    convolveIrPitchOffset.value, convolveIrPitchOffset.minValue, convolveIrPitchOffset.maxValue,
    convolveIrPitchOffset.modulationAmounts, convolveIrPitchOffset.contextualModAmounts,
    coords.dest, 0, audioLevelDb
  );
  float gain = applyModulation(
    convolveGain.value, convolveGain.minValue, convolveGain.maxValue,
    convolveGain.modulationAmounts, convolveGain.contextualModAmounts,
    coords.dest, 0, audioLevelDb
  );

  float irBaseV = clamp(coords.dest.y + irPitchOff, 0.0, 1.0);

  // ---- Hoisted band metadata ------------------------------------------------
  // Each gaborator band has its own time resolution (bandTimeScale = 2^exp).
  // To convolve CORRECTLY we must iterate in band-local frames — one tap per
  // band frame — otherwise low-frequency bands (which have large time scales
  // and thus fewer frames) read the same frame multiple times in a row and
  // get scaled up by the timeScale factor. Advance time in band-local space.

  float srcBandIndex = floor((1.0 - coords.source.y) * sourceBandCount);
  vec4  srcMeta = fetchBandMetadata(sourceMetadataTex, srcBandIndex);
  float srcBandStart     = srcMeta.r;
  float srcBandLength    = srcMeta.g;
  float srcBandTimeScale = exp2(srcMeta.b);
  ivec2 srcTexSize = textureSize(sourceSpectrogramTex, 0);
  float srcTexWidthF = float(max(srcTexSize.x, 1));
  int   srcMaxPx = max(srcTexSize.x - 1, 0);
  int   srcMaxPy = max(srcTexSize.y - 1, 0);

  float irBandIndex = floor((1.0 - irBaseV) * convolveIrBandCount);
  vec4  irMeta = fetchBandMetadata(convolveIrMetadataTex, irBandIndex);
  float irBandStart     = irMeta.r;
  float irBandLength    = irMeta.g;
  float irBandTimeScale = exp2(irMeta.b);
  ivec2 irTexSize = textureSize(convolveIrTex, 0);
  float irTexWidthF = float(max(irTexSize.x, 1));
  int   irMaxPx = max(irTexSize.x - 1, 0);
  int   irMaxPy = max(irTexSize.y - 1, 0);

  // Band-local starting index for source (where tap 0 reads from).
  // coords.source.x is in [0, 1] UV; multiply by frameCount to get master
  // frames, divide by band's time scale to get this band's local index.
  float srcBaseBandIdx = (coords.source.x * sourceFrameCount) / srcBandTimeScale;
  float irBaseBandIdx  = (irTimeOff * convolveIrFrameCount) / irBandTimeScale;

  // Effective tap count: min of user setting and the IR's band frame count.
  // At low-freq bands the IR has fewer frames so fewer real taps exist.
  int effectiveTaps = int(min(float(convolveIrSize), irBandLength));

  // Origin: tap 0 sits at (srcBaseBandIdx + originBase). Forwards -> originBase=0
  // (tap 0 at source pos, later taps read past). Backwards -> originBase=N
  // (tap 0 in future, taps converge to source pos). Middle -> N/2.
  float originBase = 0.0;
  if (convolveOrigin == 1) originBase = float(effectiveTaps) * 0.5;
  else if (convolveOrigin == 2) originBase = float(effectiveTaps);

  vec2 accumL = vec2(0.0);
  vec2 accumR = vec2(0.0);

  // WebGL2 requires a compile-time bound; break once we pass the runtime size.
  for (int k = 0; k < 512; k++) {
    if (k >= effectiveTaps) break;

    // Source band-local index shifted by origin/tap.
    float srcBandIdxF = srcBaseBandIdx + (originBase - float(k));
    float srcIdx = clamp(floor(srcBandIdxF), 0.0, srcBandLength - 1.0);
    float srcPixel = srcBandStart + srcIdx;
    int srcPx = clamp(int(mod(srcPixel, srcTexWidthF)), 0, srcMaxPx);
    int srcPy = clamp(int(floor(srcPixel / srcTexWidthF)), 0, srcMaxPy);
    vec4 srcTexel = texelFetch(sourceSpectrogramTex, ivec2(srcPx, srcPy), 0);

    // IR band-local index (tap k plus offset).
    float irBandIdxF = irBaseBandIdx + float(k) + 0.5;
    float irIdx = clamp(floor(irBandIdxF), 0.0, irBandLength - 1.0);
    float irPixel = irBandStart + irIdx;
    int irPx = clamp(int(mod(irPixel, irTexWidthF)), 0, irMaxPx);
    int irPy = clamp(int(floor(irPixel / irTexWidthF)), 0, irMaxPy);
    vec4 irTexel = texelFetch(convolveIrTex, ivec2(irPx, irPy), 0);

    // Complex multiply (mag*mag, phase+phase), accumulate in cartesian for
    // correct complex sums across taps.
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
