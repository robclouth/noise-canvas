// Brush footprint and the canvas wrap it lives on.
//
// wrapMode makes an axis of the canvas cyclic: a brush that runs off one edge
// continues from the opposite one, and reads that leave the file come back in
// from the other side. Every brush-relative computation must therefore go
// through getEffectiveBrushOffset rather than subtracting brushBottomLeftUv,
// and every out-of-file read must go through wrapUv — otherwise the wrapped
// part of the brush is treated as lying far outside it.

uniform vec2 brushBottomLeftUv;
uniform vec2 brushSizeUv;
uniform int  wrapMode; // 0=Off, 1=Wrap X, 2=Wrap Y, 3=Wrap Both
// The file's length in the canvas's UV: the period a wrapping time axis
// repeats at. One while the canvas holds the whole file.
uniform float brushWrapSpanX;

bool wrapsTimeAxis()  { return wrapMode == 1 || wrapMode == 3; }
bool wrapsPitchAxis() { return wrapMode == 2 || wrapMode == 3; }

// Position relative to the brush origin. On a wrapping axis the offset is taken
// modulo the file, so a fragment at the far edge sits just past the brush
// start rather than a whole file behind it.
vec2 getEffectiveBrushOffset(vec2 unpackedUv) {
  vec2 offset = unpackedUv - brushBottomLeftUv;
  float period = max(brushWrapSpanX, 1e-6);
  float wrappedX = offset.x - period * floor(offset.x / period);
  return vec2(wrapsTimeAxis() ? wrappedX : offset.x, wrapsPitchAxis() ? fract(offset.y) : offset.y);
}
