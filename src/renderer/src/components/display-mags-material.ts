import { GLSL3, RawShaderMaterial } from "three";

/**
 * Scatters window canvas pixels into the file-sized display texture, encoding
 * magnitudes as dB. One instance per (fileStart, count, windowStart) triplet:
 * the vertex shader spans the file range's pixel bounding box, the fragment
 * shader keeps the pixels inside the range and reads each one's packed value
 * from the window canvas. With a whole-file window the mapping is the
 * identity, so one material serves both.
 */
export const displayMagsMaterial = new RawShaderMaterial({
  uniforms: {
    inputTex: { value: null },
    destWidth: { value: 0 },
    destHeight: { value: 0 },
    srcWidth: { value: 0 },
  },
  vertexShader: /*glsl*/ `
    precision highp float;
    precision highp int;

    in vec3 position;
    in uvec3 aRange;

    uniform int destWidth;
    uniform int destHeight;

    flat out uvec3 vRange;

    void main() {
      uint w = uint(destWidth);
      uint destStart = aRange.x;
      uint destEnd = destStart + aRange.y;
      vRange = aRange;

      uint row0 = destStart / w;
      uint row1 = (destEnd - 1u) / w;
      // A range confined to one row spans only its own columns; one crossing a
      // row boundary is bounded by the full width.
      float x0 = row0 == row1 ? float(destStart - row0 * w) : 0.0;
      float x1 = row0 == row1 ? float(destEnd - row0 * w) : float(w);

      float x = mix(x0, x1, position.x);
      float y = mix(float(row0), float(row1 + 1u), position.y);

      gl_Position = vec4(
        2.0 * x / float(destWidth) - 1.0,
        2.0 * y / float(destHeight) - 1.0,
        0.0,
        1.0
      );
    }
  `,
  fragmentShader: /*glsl*/ `
    precision highp float;
    precision highp sampler2D;
    precision highp int;

    flat in uvec3 vRange;

    uniform sampler2D inputTex;
    uniform int destWidth;
    uniform int srcWidth;

    out vec4 outColor;

    const float DISPLAY_MAGS_EPSILON = 1.0e-7;

    float displayMagToDb(float mag) {
      return 20.0 * log(mag + DISPLAY_MAGS_EPSILON) / log(10.0);
    }

    void main() {
      uint destPixel = uint(gl_FragCoord.y) * uint(destWidth) + uint(gl_FragCoord.x);
      // The bounding box overhangs the range at both ends when it wraps rows.
      if (destPixel < vRange.x || destPixel >= vRange.x + vRange.y) discard;

      uint srcPixel = vRange.z + (destPixel - vRange.x);
      vec4 texel = texelFetch(inputTex, ivec2(int(srcPixel % uint(srcWidth)), int(srcPixel / uint(srcWidth))), 0);
      outColor = vec4(displayMagToDb(texel.r), displayMagToDb(texel.b), 0.0, 0.0);
    }
  `,
  glslVersion: GLSL3,
  depthTest: false,
  depthWrite: false,
});
