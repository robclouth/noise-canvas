import { GLSL3, RawShaderMaterial } from "three";

/**
 * Gathers arbitrary pixel ranges of a packed FBO into one compact block, the
 * inverse of the patch material's scatter. One instance per range: the vertex
 * shader spans the rows of the compact target the range lands on, the
 * fragment shader keeps only the pixels inside the range's span and reads
 * each from its place in the source. Reading the block back costs a fraction
 * of reading the whole packed state, which for a long file is hundreds of
 * megabytes.
 *
 * Instance attribute `aRange` is (srcPixelStart, pixelCount, destPixelStart).
 */
export const gatherMaterial = new RawShaderMaterial({
  uniforms: {
    sourceTex: { value: null },
    sourceWidth: { value: 0 },
    destWidth: { value: 0 },
    destHeight: { value: 0 },
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
      uint destStart = aRange.z;
      uint destEnd = destStart + aRange.y;
      vRange = aRange;

      uint row0 = destStart / w;
      uint row1 = (destEnd - 1u) / w;
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

    uniform sampler2D sourceTex;
    uniform int sourceWidth;
    uniform int destWidth;

    out vec4 outColor;

    void main() {
      uint destPixel = uint(gl_FragCoord.y) * uint(destWidth) + uint(gl_FragCoord.x);
      if (destPixel < vRange.z || destPixel >= vRange.z + vRange.y) discard;

      uint srcPixel = vRange.x + (destPixel - vRange.z);
      outColor = texelFetch(sourceTex, ivec2(int(srcPixel % uint(sourceWidth)), int(srcPixel / uint(sourceWidth))), 0);
    }
  `,
  glslVersion: GLSL3,
  depthTest: false,
  depthWrite: false,
});
