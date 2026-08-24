import { GLSL3, RawShaderMaterial, Vector2 } from "three";
import rangeQuadVert from "../glsl/range-quad.vert";

/** Copies the pixels of the drawn ranges from inputTex into the bound target. */
export const rangeCopyMaterial = new RawShaderMaterial({
  uniforms: {
    inputTex: { value: null },
    destSpectrogramTextureSize: { value: new Vector2(1, 1) },
  },
  vertexShader: rangeQuadVert,
  fragmentShader: /*glsl*/ `
    precision highp float;
    precision highp sampler2D;
    precision highp int;

    uniform sampler2D inputTex;
    out vec4 outColor;

    void main() {
      outColor = texelFetch(inputTex, ivec2(gl_FragCoord.xy), 0);
    }
  `,
  glslVersion: GLSL3,
  depthTest: false,
  depthWrite: false,
});
