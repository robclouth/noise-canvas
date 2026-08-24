#include "../glsl/effect-common.glsl"

// Measures the UV round trip the addressing depends on: the inverse map stores
// a whole frame, divides it by the frame count to reach the shader, and the
// addressing multiplies it back. One output column per sampled frame, one row
// per band; .r is the bin the helper picks and .g the frame it recovered.
uniform float probeFrameOrigin;
uniform float probeFrameStride;

void main() {
  float frame = probeFrameOrigin + floor(gl_FragCoord.x) * probeFrameStride;
  float u = frame / max(1.0, sourceFrameCount);
  float timeInFrames = u * sourceFrameCount;

  PackedBand band = fetchPackedBand(sourceMetadataTex, floor(gl_FragCoord.y));
  bool resident;
  float bin = bandBinOfFrame(band, timeInFrames, resident);

  outColor = vec4(bin, timeInFrames, floor(timeInFrames + 0.5), 0.0);
}
