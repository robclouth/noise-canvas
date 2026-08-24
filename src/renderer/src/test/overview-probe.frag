#include "../glsl/effect-common.glsl"
#include "../glsl/overview.glsl"

// Probes the display's window/overview choice: .r and .b are the magnitudes a
// display read would blend, .g the overview's share of them, .a the bins from
// the nearer edge of what the packed texture holds.
uniform float probeFrameOrigin;
uniform float probeFrameStride;

void main() {
  float frame = probeFrameOrigin + floor(gl_FragCoord.x) * probeFrameStride;
  vec2 uv = vec2(frame / max(sourceFrameCount, 1.0),
                 1.0 - (floor(gl_FragCoord.y) + 0.5) / max(sourceBandCount, 1.0));

  float blend = overviewBlend(uv, sourceMetadataTex, sourceFrameCount, sourceBandCount);
  vec4 overview = sampleOverviewMagnitudes(uv, sourceFrameCount, sourceBandCount);
  bool resident;
  vec4 windowed = readPackedDataInterpolatedResident(uv, sourceSpectrogramTex, sourceMetadataTex,
                                                     sourceFrameCount, sourceBandCount, resident);

  PackedBand band = fetchPackedBand(sourceMetadataTex, floor((1.0 - uv.y) * sourceBandCount));
  outColor = vec4(mix(windowed.r, overview.r, blend), blend, overview.r,
                  bandResidencyMargin(band, uv.x * sourceFrameCount));
}
