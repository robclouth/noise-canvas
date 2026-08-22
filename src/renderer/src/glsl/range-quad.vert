precision highp float;
precision highp sampler2D;
precision highp int;

// One instance per packed pixel range (start, count). A range confined to one
// row spans only its own columns; one that is row-aligned at both ends spans
// the full width of every row it covers. vUv at a pixel centre matches what a
// full-screen quad would interpolate there.
in vec3 position;
in uvec2 aRange;

uniform vec2 destSpectrogramTextureSize;

out vec2 vUv;

void main() {
  uint w = uint(destSpectrogramTextureSize.x);
  uint start = aRange.x;
  uint end = start + aRange.y;
  uint row0 = start / w;
  uint row1 = (end - 1u) / w;
  float x0 = row0 == row1 ? float(start - row0 * w) : 0.0;
  float x1 = row0 == row1 ? float(end - row0 * w) : float(w);
  float x = mix(x0, x1, position.x);
  float y = mix(float(row0), float(row1 + 1u), position.y);
  vUv = vec2(x, y) / destSpectrogramTextureSize;
  gl_Position = vec4(2.0 * vUv - 1.0, 0.0, 1.0);
}
