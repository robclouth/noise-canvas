#include "../glsl/effect-common.glsl"

// Probes packedTexel's float addressing: each column asks for the texel at
// baseIndex + x, and writes the coordinates the GPU's float32 resolved.
uniform float baseIndex;

void main() {
  float index = baseIndex + floor(gl_FragCoord.x);
  ivec2 texel = packedTexel(index, ivec2(8192, 8192));
  outColor = vec4(float(texel.x), float(texel.y), index - baseIndex, 0.0);
}
