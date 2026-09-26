#include "effect-common.glsl"

// Writes what the automaton grew back into the spectrogram. Each band reads
// the grid at its place in the brush, and the level channel sets its
// magnitude. The phase follows the path the model grew, from where the learnt
// sound's phase started on that row, for the energy the model added (mode 0),
// or is fresh noise (mode 1), or is the phase already there (mode 2). Where the sound was already stereo,
// each channel keeps its share of the level.

uniform sampler2D ncaState0;
// Per row: where the learnt phase path starts, as a turn (r); how rough it is,
// 0–1 (g); the loudest level it reaches in the learnt sound (b).
uniform sampler2D ncaRows;
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

const float NCA_PATH_SCALE = 32.0;

// The grown phase at a place in the brush: the row's anchor plus the path the
// model grew along that row, between cell centres.
float grownPhase(vec2 local) {
  int row = clamp(int(floor(clamp(local.y, 0.0, 1.0) * float(ncaGrid))), 0, ncaGrid - 1);
  float position = clamp(local.x, 0.0, 1.0) * float(ncaGrid) - 0.5;
  int col = int(floor(position));
  float f = position - float(col);
  float a = texelFetch(ncaState0, ivec2(clamp(col, 0, ncaGrid - 1), row), 0).y;
  float b = texelFetch(ncaState0, ivec2(clamp(col + 1, 0, ncaGrid - 1), row), 0).y;
  float anchor = texelFetch(ncaRows, ivec2(row, 0), 0).r * TWO_PI - PI;
  return anchor + mix(a, b, f) * NCA_PATH_SCALE;
}

// How far the learnt sound's phase jitters on this row, from 0 (a smooth path)
// to 1 (random).
float rowRoughness(vec2 local) {
  int row = clamp(int(floor(clamp(local.y, 0.0, 1.0) * float(ncaGrid))), 0, ncaGrid - 1);
  return texelFetch(ncaRows, ivec2(row, 0), 0).g;
}

// `target` on the branch nearest `reference`, so a stored phase stays unwrapped.
float nearestBranch(float target, float reference) {
  float diff = target - reference;
  return reference + diff - TWO_PI * floor(diff / TWO_PI + 0.5);
}

// The phase of a band that goes from `fromMagnitude` at `fromPhase` to
// `toMagnitude`: its own phase weighted by what it had, the learnt phase by
// what was added. Returned on the branch nearest `fromPhase`.
float blendPhase(float fromPhase, float fromMagnitude, float learnt, float toMagnitude) {
  float added = max(toMagnitude - fromMagnitude, 0.0);
  vec2 sum = fromMagnitude * vec2(cos(fromPhase), sin(fromPhase)) + added * vec2(cos(learnt), sin(learnt));
  if (dot(sum, sum) < 1e-24) return nearestBranch(learnt, fromPhase);
  return nearestBranch(atan(sum.y, sum.x), fromPhase);
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
  // Never louder than the learnt sound got on this row, however often it is painted.
  int row = clamp(int(floor(clamp(local.y, 0.0, 1.0) * float(ncaGrid))), 0, ncaGrid - 1);
  float magnitude = ncaMagnitudeOf(min(grown.x, texelFetch(ncaRows, ivec2(row, 0), 0).b));

  float meanMagnitude = 0.5 * (originalTexel.r + originalTexel.b);
  vec2 share = meanMagnitude > 1e-6 ? clamp(vec2(originalTexel.r, originalTexel.b) / meanMagnitude, 0.0, 2.0) : vec2(1.0);
  float phaseL = originalTexel.g;
  float phaseR = originalTexel.a;
  if (neuralPhaseMode == 0 && ncaHasPhase) {
    // A smooth path turns a noisy band into a steady tone, and a bank of those
    // sounds like a comb, so rough rows get per-coefficient jitter back.
    float learnt = grownPhase(local) + noisePhase(vUv, 2.0) * rowRoughness(local);
    // Only energy the model adds takes the learnt phase: a band that keeps its
    // level keeps its own phase, and one grown out of silence takes the learnt
    // one, so painting a little at a time moves the sound only a little.
    phaseL = blendPhase(originalTexel.g, originalTexel.r, learnt, magnitude * share.x);
    phaseR = blendPhase(originalTexel.a, originalTexel.b, learnt, magnitude * share.y);
  } else if (neuralPhaseMode != 2) {
    phaseL = nearestBranch(noisePhase(vUv, 0.0), originalTexel.g);
    phaseR = nearestBranch(noisePhase(vUv, 1.0), originalTexel.a);
  }

  vec4 resultTexel = vec4(magnitude * share.x, phaseL, magnitude * share.y, phaseR);
  outColor = applyBrush(originalTexel, resultTexel, weight, coords.dest, vUv);
}
