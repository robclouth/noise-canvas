precision highp float;
precision highp sampler2D;
precision highp int;

#include "display-mags.glsl";

// Encodes the drawn ranges of a packed RGBA32F canvas into display dB, left
// magnitude to R and right magnitude to G.
uniform sampler2D inputTex;
out vec4 outColor;

void main() {
  vec4 texel = texelFetch(inputTex, ivec2(gl_FragCoord.xy), 0);
  outColor = vec4(displayMagToDb(texel.r), displayMagToDb(texel.b), 0.0, 0.0);
}
