#include "effect-common.glsl"

// Writes what the automaton grew back into the spectrogram. Each band reads
// the grid at its place in the brush, and the level channel sets its
// magnitude. Models learn level, not phase, so the phase comes from the learnt
// sound's own phase at that place (mode 0), fresh noise (mode 1), or the phase
// already there (mode 2). Where the sound was already stereo, each channel
// keeps its share of the level.

uniform sampler2D ncaState0;
uniform sampler2D ncaPhase; // the learnt phase per cell, as a turn from 0 to 1
uniform bool ncaHasPhase;
uniform int ncaGrid;
uniform int neuralPhaseMode;

const float NCA_DB_RANGE = 90.0;

float ncaMagnitudeOf(float level) {
  if (level <= 0.0) return 0.0;
  return pow(10.0, (level - 1.0) * NCA_DB_RANGE / 20.0);
}

// Bilinear read of the audible channels between cell centres.
vec3 sampleGrid(vec2 local) {
  vec2 position = clamp(local, 0.0, 1.0) * float(ncaGrid) - 0.5;
  vec2 base = floor(position);
  vec2 f = position - base;
  ivec2 last = ivec2(ncaGrid - 1);
  ivec2 c00 = clamp(ivec2(base), ivec2(0), last);
  ivec2 c11 = clamp(ivec2(base) + 1, ivec2(0), last);
  vec3 a = texelFetch(ncaState0, c00, 0).xyz;
  vec3 b = texelFetch(ncaState0, ivec2(c11.x, c00.y), 0).xyz;
  vec3 c = texelFetch(ncaState0, ivec2(c00.x, c11.y), 0).xyz;
  vec3 d = texelFetch(ncaState0, c11, 0).xyz;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// The learnt phase between cell centres, blended as unit vectors so it never
// wraps the long way round.
float sampleLearntPhase(vec2 local) {
  vec2 position = clamp(local, 0.0, 1.0) * float(ncaGrid) - 0.5;
  vec2 base = floor(position);
  vec2 f = position - base;
  ivec2 last = ivec2(ncaGrid - 1);
  ivec2 c00 = clamp(ivec2(base), ivec2(0), last);
  ivec2 c11 = clamp(ivec2(base) + 1, ivec2(0), last);
  float a = texelFetch(ncaPhase, c00, 0).r * TWO_PI;
  float b = texelFetch(ncaPhase, ivec2(c11.x, c00.y), 0).r * TWO_PI;
  float c = texelFetch(ncaPhase, ivec2(c00.x, c11.y), 0).r * TWO_PI;
  float d = texelFetch(ncaPhase, c11, 0).r * TWO_PI;
  vec2 blended = mix(mix(vec2(cos(a), sin(a)), vec2(cos(b), sin(b)), f.x), mix(vec2(cos(c), sin(c)), vec2(cos(d), sin(d)), f.x), f.y);
  return atan(blended.y, blended.x) - PI;
}

// `target` on the branch nearest `reference`, so a stored phase stays unwrapped.
float nearestBranch(float target, float reference) {
  float diff = target - reference;
  return reference + diff - TWO_PI * floor(diff / TWO_PI + 0.5);
}

// A phase per coefficient that stays put from dab to dab.
float noisePhase(vec2 packedUv, float channel) {
  vec3 p3 = fract(vec3(packedUv.xyx * vec2(1.0, 1.0 + channel).xyx) * vec3(443.897, 441.423, 437.195));
  p3 += dot(p3, p3.yzx + 19.19);
  return (fract((p3.x + p3.y) * p3.z) * 2.0 - 1.0) * PI;
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

  vec2 local = getEffectiveBrushOffset(coords.dest) / max(brushSizeUv, vec2(1e-9));
  vec3 grown = sampleGrid(local);
  float magnitude = ncaMagnitudeOf(grown.x);

  float meanMagnitude = 0.5 * (originalTexel.r + originalTexel.b);
  vec2 share = meanMagnitude > 1e-6 ? clamp(vec2(originalTexel.r, originalTexel.b) / meanMagnitude, 0.0, 2.0) : vec2(1.0);
  float phaseL = originalTexel.g;
  float phaseR = originalTexel.a;
  if (neuralPhaseMode == 0 && ncaHasPhase) {
    float learnt = sampleLearntPhase(local);
    phaseL = nearestBranch(learnt, originalTexel.g);
    phaseR = nearestBranch(learnt, originalTexel.a);
  } else if (neuralPhaseMode != 2) {
    phaseL = nearestBranch(noisePhase(vUv, 0.0), originalTexel.g);
    phaseR = nearestBranch(noisePhase(vUv, 1.0), originalTexel.a);
  }

  vec4 resultTexel = vec4(magnitude * share.x, phaseL, magnitude * share.y, phaseR);
  outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
