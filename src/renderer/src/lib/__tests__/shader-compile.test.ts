import { WebGLRenderer } from "three";
import { describe, expect, it } from "vitest";

/**
 * Every shader in `glsl/` must compile. A GLSL compile failure is silent at
 * runtime — three logs it and the draw produces a black target — so without
 * this the first sign of a broken shader is an effect quietly outputting
 * nothing. Globbed rather than listed, so a new shader is covered by existing.
 */

const fragments = import.meta.glob("../../glsl/*.frag", { eager: true, import: "default" }) as Record<string, string>;
const vertices = import.meta.glob("../../glsl/*.vert", { eager: true, import: "default" }) as Record<string, string>;

describe("shader compilation", () => {
  const renderer = new WebGLRenderer();
  const gl = renderer.getContext();

  function compile(source: string, kind: number): string | null {
    const shader = gl.createShader(kind);
    if (!shader) throw new Error("The GL context gave no shader object.");
    gl.shaderSource(shader, `#version 300 es\n${source}`);
    gl.compileShader(shader);
    const log = gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    return log;
  }

  it("finds the shaders to check", () => {
    expect(Object.keys(fragments).length).toBeGreaterThan(10);
    expect(Object.keys(vertices).length).toBeGreaterThan(0);
  });

  for (const [path, source] of Object.entries(fragments)) {
    it(`compiles ${path.split("/").pop()}`, () => {
      expect(compile(source, gl.FRAGMENT_SHADER)).toBeNull();
    });
  }

  for (const [path, source] of Object.entries(vertices)) {
    it(`compiles ${path.split("/").pop()}`, () => {
      expect(compile(source, gl.VERTEX_SHADER)).toBeNull();
    });
  }
});
