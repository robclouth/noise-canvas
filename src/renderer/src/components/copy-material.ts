import { GLSL3, RawShaderMaterial } from "three";

export const copyMaterial = new RawShaderMaterial({
  uniforms: {
    inputTex: { value: null },
  },
  vertexShader: /*glsl*/ `
    precision highp float;
    precision highp sampler2D;
    precision highp int;

    in vec3 position;
    in vec2 uv;

    out vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: /*glsl*/ `    
    precision highp float;
    precision highp sampler2D;
    precision highp int;

    in vec2 vUv;

    uniform sampler2D inputTex;
    out vec4 outColor;

    void main() {
      outColor = texture(inputTex, vUv);
    }
  `,
  glslVersion: GLSL3,
});
