precision highp float;
varying vec2 vUv;

#include "brush-common.glsl";
#include "brush-wrapper.glsl";

vec4 applyBrushStroke(vec4 sourceTexel, ProcessingUvs coords) {
  return getOriginalDestSample(coords.dest);
}
