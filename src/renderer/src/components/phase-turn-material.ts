import { GLSL3, RawShaderMaterial } from "three";

/**
 * Copies arbitrary pixel ranges from one packed texture into another of the
 * same layout, adding a per-range offset to each channel's phase on the way.
 * One instance per range, drawn like the patch material's scatter. With zero
 * offsets it is a plain copy of the ranges, which is how the turned pixels get
 * back into the committed buffer without a feedback loop.
 *
 * Instance attributes: `aRange` is (pixelStart, pixelCount), `aOffset` the
 * phase offset for the left and right channel. An offset of exactly zero is
 * skipped rather than added, so a negative zero keeps its sign.
 */
export const phaseTurnMaterial = new RawShaderMaterial({
  uniforms: {
    sourceTex: { value: null },
    width: { value: 0 },
    height: { value: 0 },
  },
  vertexShader: /*glsl*/ `
    precision highp float;
    precision highp int;

    in vec3 position;
    in uvec2 aRange;
    in vec2 aOffset;

    uniform int width;
    uniform int height;

    flat out uvec2 vRange;
    flat out vec2 vOffset;

    void main() {
      uint w = uint(width);
      uint start = aRange.x;
      uint end = start + aRange.y;
      vRange = aRange;
      vOffset = aOffset;

      uint row0 = start / w;
      uint row1 = (end - 1u) / w;
      float x0 = row0 == row1 ? float(start - row0 * w) : 0.0;
      float x1 = row0 == row1 ? float(end - row0 * w) : float(w);

      float x = mix(x0, x1, position.x);
      float y = mix(float(row0), float(row1 + 1u), position.y);

      gl_Position = vec4(
        2.0 * x / float(width) - 1.0,
        2.0 * y / float(height) - 1.0,
        0.0,
        1.0
      );
    }
  `,
  fragmentShader: /*glsl*/ `
    precision highp float;
    precision highp sampler2D;
    precision highp int;

    flat in uvec2 vRange;
    flat in vec2 vOffset;

    uniform sampler2D sourceTex;
    uniform int width;

    out vec4 outColor;

    void main() {
      uint pixel = uint(gl_FragCoord.y) * uint(width) + uint(gl_FragCoord.x);
      if (pixel < vRange.x || pixel >= vRange.x + vRange.y) discard;

      vec4 v = texelFetch(sourceTex, ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y)), 0);
      if (vOffset.x != 0.0) v.y = v.y + vOffset.x;
      if (vOffset.y != 0.0) v.w = v.w + vOffset.y;
      outColor = v;
    }
  `,
  glslVersion: GLSL3,
  depthTest: false,
  depthWrite: false,
});
