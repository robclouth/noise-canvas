precision highp float;
varying vec2 vUv;

#include "brush-common.glsl";
#include "brush-wrapper.glsl"

uniform Parameter gainDb;

vec4 applyBrushStroke(vec4 sourceTexel, ProcessingUvs coords) {
  float gainDbValue = applyModulation(gainDb.value, gainDb.minValue, gainDb.maxValue, gainDb.modulationAmounts, coords.dest);
  float gain = pow(10.0, gainDbValue / 20.0);
  return sourceTexel * gain;
}
