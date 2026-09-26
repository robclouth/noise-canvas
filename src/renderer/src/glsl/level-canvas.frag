precision highp float;
precision highp sampler2D;
precision highp int;

#include "display-mags.glsl"

// A display pyramid level, in dB, drawn as a canvas laid out in the same
// packed order: its magnitudes with zero phase, and silence where the level
// holds nothing yet.
uniform sampler2D levelTex;
uniform float targetWidth;

out vec4 outColor;

void main() {
  float linear = floor(gl_FragCoord.y) * targetWidth + floor(gl_FragCoord.x);
  ivec2 size = textureSize(levelTex, 0);
  float width = float(max(size.x, 1));
  ivec2 texel = clamp(ivec2(int(mod(linear, width)), int(floor(linear / width))), ivec2(0), size - ivec2(1));
  vec2 db = texelFetch(levelTex, texel, 0).rg;
  vec2 mags = displayDbKnown(db) ? vec2(displayDbToMag(db.x), displayDbToMag(db.y)) : vec2(0.0);
  outColor = vec4(mags.x, 0.0, mags.y, 0.0);
}
