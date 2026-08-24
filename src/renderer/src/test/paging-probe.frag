#include "../glsl/effect-common.glsl"

// Probes the centralised packed addressing directly: one output column per
// sampled file frame, one row per band. The same shader runs against a
// whole-file texture and against a window of it, and the two must agree
// wherever the window reports the frame resident.
uniform float probeFrameOrigin;
uniform float probeFrameStride;

void main() {
  float frame = probeFrameOrigin + floor(gl_FragCoord.x) * probeFrameStride;
  vec2 uv = vec2(frame / max(sourceFrameCount, 1.0),
                 1.0 - (floor(gl_FragCoord.y) + 0.5) / max(sourceBandCount, 1.0));

  bool pointResident;
  vec4 point = readPackedDataResident(uv, sourceSpectrogramTex, sourceMetadataTex,
                                      sourceFrameCount, sourceBandCount, pointResident);
  bool interpResident;
  vec4 interp = readPackedDataInterpolatedResident(uv, sourceSpectrogramTex, sourceMetadataTex,
                                                   sourceFrameCount, sourceBandCount, interpResident);

  outColor = vec4(point.r, pointResident ? 1.0 : 0.0, interp.r, interpResident ? 1.0 : 0.0);
}
