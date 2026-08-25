import { GLSL3, RawShaderMaterial, Vector2 } from "three";
import displayMagsBuildFrag from "../glsl/display-mags-build.frag";
import rangeQuadVert from "../glsl/range-quad.vert";

/** Encodes the drawn ranges of a packed canvas into the RG16F display texture. */
export const displayMagsMaterial = new RawShaderMaterial({
  uniforms: {
    inputTex: { value: null },
    destSpectrogramTextureSize: { value: new Vector2(1, 1) },
  },
  vertexShader: rangeQuadVert,
  fragmentShader: displayMagsBuildFrag,
  glslVersion: GLSL3,
  depthTest: false,
  depthWrite: false,
});
