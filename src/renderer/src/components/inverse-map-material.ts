import { GLSL3, RawShaderMaterial } from "three";

/**
 * Draws a view's inverse map — [frame in the view, band] per packed pixel —
 * from the view's metadata texture, as `canvasViewInverseMap` lays it out:
 * padding pixels map to the lowest band at frame 0. Exact while the view holds
 * no more than 2^24 texels, since its band offsets are floats.
 */
export const inverseMapMaterial = new RawShaderMaterial({
  uniforms: {
    metaTex: { value: null },
    numBands: { value: 0 },
    textureWidth: { value: 1 },
  },
  vertexShader: /*glsl*/ `
    precision highp float;
    precision highp int;

    in vec3 position;

    void main() {
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: /*glsl*/ `
    precision highp float;
    precision highp sampler2D;
    precision highp int;

    uniform sampler2D metaTex;
    uniform int numBands;
    uniform int textureWidth;
    out vec4 outColor;

    void main() {
      ivec2 at = ivec2(gl_FragCoord.xy);
      float pixel = float(at.y * textureWidth + at.x);
      // The last band starting at or before the pixel. A band holding no bins
      // starts where the next does, so the search passes over it.
      int low = 0;
      int high = numBands - 1;
      while (low < high) {
        int mid = (low + high + 1) / 2;
        if (texelFetch(metaTex, ivec2(mid, 0), 0).r <= pixel) low = mid;
        else high = mid - 1;
      }
      vec4 meta = texelFetch(metaTex, ivec2(low, 0), 0);
      if (pixel >= meta.r + meta.g) {
        outColor = vec4(0.0, float(numBands - 1), 0.0, 1.0);
        return;
      }
      outColor = vec4((pixel - meta.r) * exp2(meta.b), float(low), 0.0, 1.0);
    }
  `,
  glslVersion: GLSL3,
});
