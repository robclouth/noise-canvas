import { GLSL3, RawShaderMaterial } from "three";

/**
 * Scatters a compact block of packed pixels into an FBO at arbitrary pixel
 * ranges. One instance per range: the vertex shader spans the range's pixel
 * bounding box, the fragment shader keeps only the pixels actually inside the
 * range and reads its value from the compact patch texture. Uploading just the
 * changed pixels this way costs a fraction of re-uploading the whole packed
 * state, which for a long file is hundreds of megabytes.
 *
 * Instance attribute `aRange` is (destPixelStart, pixelCount, srcPixelStart).
 */
export const patchMaterial = new RawShaderMaterial({
  uniforms: {
    patchTex: { value: null },
    destWidth: { value: 0 },
    destHeight: { value: 0 },
    patchWidth: { value: 0 },
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

    uniform sampler2D patchTex;
    uniform int destWidth;
    uniform int patchWidth;

    out vec4 outColor;

    void main() {
      uint destPixel = uint(gl_FragCoord.y) * uint(destWidth) + uint(gl_FragCoord.x);
      // The bounding box overhangs the range at both ends when it wraps rows.
      if (destPixel < vRange.x || destPixel >= vRange.x + vRange.y) discard;

      uint srcPixel = vRange.z + (destPixel - vRange.x);
      outColor = texelFetch(patchTex, ivec2(int(srcPixel % uint(patchWidth)), int(srcPixel / uint(patchWidth))), 0);
    }
  `,
  glslVersion: GLSL3,
  depthTest: false,
  depthWrite: false,
});
