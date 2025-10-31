import { GLSL3, ShaderMaterial } from "three";

export const copyMaterial = new ShaderMaterial({
  uniforms: {
    inputTex: { value: null },
  },
  vertexShader: /*glsl*/ `
    out vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: /*glsl*/ `    
    precision highp float;
    in vec2 vUv;
    uniform sampler2D inputTex;
    out vec4 fragColor;

    void main() {
      fragColor = texture(inputTex, vUv);
    }
  `,
  glslVersion: GLSL3,
});
