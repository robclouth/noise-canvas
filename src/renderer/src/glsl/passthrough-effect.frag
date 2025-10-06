precision highp float;
varying vec2 vUv;

#include "effect-common.glsl";
#include "effect-wrapper.glsl"

vec4 applyEffectStroke(vec4 sourceTexel, ProcessingUvs coords) {
  return sourceTexel;
}

