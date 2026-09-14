import {
  AdditiveBlending,
  Color,
  NearestFilter,
  RawShaderMaterial,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import { createByteTarget, drawCompositionToTarget } from "./snapshot-capture";
import { perfAdd, perfEnabled } from "./perf-probe";

/** Owns the exact, byte-sized picture behind a view's top layer. */
export class ViewBackdrop {
  private target: WebGLRenderTarget | null = null;
  private dirty = true;
  readonly material = new RawShaderMaterial({
    uniforms: { backdrop: { value: null } },
    vertexShader: `precision highp float;
      attribute vec3 position;
      varying vec2 uv;
      void main() { uv = position.xy * 0.5 + 0.5; gl_Position = vec4(position, 1.0); }`,
    fragmentShader: `precision highp float;
      uniform sampler2D backdrop;
      varying vec2 uv;
      void main() { gl_FragColor = vec4(texture2D(backdrop, uv).rgb, 1.0); }`,
    blending: AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  get bytes(): number {
    return this.target ? this.target.width * this.target.height * 4 : 0;
  }

  invalidate(): void {
    this.dirty = true;
  }

  ensure(gl: WebGLRenderer, width: number, height: number, draw: () => void): void {
    if (!this.target) {
      this.target = createByteTarget(width, height);
      this.target.texture.minFilter = NearestFilter;
      this.target.texture.magFilter = NearestFilter;
      this.material.uniforms.backdrop.value = this.target.texture;
    } else if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
      this.dirty = true;
    }
    if (!this.dirty) return;
    const colour = gl.getClearColor(new Color());
    const alpha = gl.getClearAlpha();
    this.dirty = false;
    try {
      gl.setClearColor(0, 0);
      drawCompositionToTarget(gl, draw, this.target);
      if (perfEnabled()) perfAdd("viewBackdropBuilds", 1);
    } catch (error) {
      this.dirty = true;
      throw error;
    } finally {
      gl.setClearColor(colour, alpha);
    }
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.material.dispose();
  }
}
