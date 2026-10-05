#include "../glsl/effect-common.glsl"

// One bin per column: R = its frame as a multiple of 4096, G = the rest, B =
// its band. Each column writes the bin's draws for salts 1 to 4.
uniform sampler2D probeTex;

void main() {
  vec4 bin = texelFetch(probeTex, ivec2(int(gl_FragCoord.x), 0), 0);
  int frame = int(bin.r) * 4096 + int(bin.g);
  int band = int(bin.b);
  outColor = vec4(randomAt(frame, band, 1u), randomAt(frame, band, 2u), randomAt(frame, band, 3u), randomAt(frame, band, 4u));
}
