precision highp float;
varying vec2 vUv;

#include "effect-common.glsl";
#include "effect-wrapper.glsl"

uniform Parameter gainDb;

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords, float audioLevelDb) {
  float gainDbValue = applyModulation(gainDb.value, gainDb.minValue, gainDb.maxValue, gainDb.modulationAmounts, coords.dest, 0, audioLevelDb);
  float gain = pow(10.0, gainDbValue / 20.0);
  return sourceTexel * gain;
}
