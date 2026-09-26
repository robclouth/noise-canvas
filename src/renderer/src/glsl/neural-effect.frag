#include "effect-common.glsl"

// Writes what the automaton grew back into the spectrogram. Each band reads
// the grid at its place in the brush: the level channel sets its magnitude,
// the phase pair its phase. Where the sound was already stereo, each channel
// keeps its share of the level.

uniform sampler2D ncaState0;
uniform int ncaGrid;

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

// `target` on the branch nearest `reference`, so a stored phase stays unwrapped.
float nearestBranch(float target, float reference) {
  float diff = target - reference;
  return reference + diff - TWO_PI * floor(diff / TWO_PI + 0.5);
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

  vec3 grown = sampleGrid(getEffectiveBrushOffset(coords.dest) / max(brushSizeUv, vec2(1e-9)));
  float magnitude = ncaMagnitudeOf(grown.x);
  bool hasPhase = length(grown.yz) > 1e-6;
  float phase = atan(grown.z, grown.y);

  float meanMagnitude = 0.5 * (originalTexel.r + originalTexel.b);
  vec2 share = meanMagnitude > 1e-6 ? clamp(vec2(originalTexel.r, originalTexel.b) / meanMagnitude, 0.0, 2.0) : vec2(1.0);
  float phaseL = hasPhase ? nearestBranch(phase, originalTexel.g) : originalTexel.g;
  float phaseR = hasPhase ? nearestBranch(phase, originalTexel.a) : originalTexel.a;

  vec4 resultTexel = vec4(magnitude * share.x, phaseL, magnitude * share.y, phaseR);
  outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
