precision highp float;
varying vec2 vUv;

#include "brush-common.glsl";
#include "brush-wrapper.glsl"

uniform float gain;

vec4 applyBrushStroke(vec4 sourceTexel, ProcessingUvs coords) {
  return sourceTexel * gain;
}
