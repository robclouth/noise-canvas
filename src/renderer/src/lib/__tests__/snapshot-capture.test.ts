import { GLSL3, RawShaderMaterial, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import passThroughVert from "../../glsl/pass-through.vert";
import { captureMaterialToCanvas } from "../snapshot-capture";

/**
 * Verifies the snapshot pipeline end-to-end on a real WebGL context: a
 * material rendered through captureMaterialToCanvas must land in the 2D
 * canvas at the requested size, in top-down row order (readPixels returns
 * bottom-up rows, which the capture flips).
 */

const uvGradientFrag = `
precision highp float;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = vec4(vUv.x, vUv.y, 0.25, 1.0);
}
`;

describe("captureMaterialToCanvas", () => {
  let gl: WebGLRenderer;
  let material: RawShaderMaterial;

  beforeEach(() => {
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    material = new RawShaderMaterial({
      vertexShader: passThroughVert,
      fragmentShader: uvGradientFrag,
      glslVersion: GLSL3,
    });
  });

  afterEach(() => {
    material.dispose();
    gl.dispose();
  });

  function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): Uint8ClampedArray {
    const ctx = canvas.getContext("2d")!;
    return ctx.getImageData(x, y, 1, 1).data;
  }

  it("renders the material into the canvas with top-down orientation", async () => {
    const canvas = document.createElement("canvas");
    const ok = await captureMaterialToCanvas(gl, material, canvas, 64, 32);
    expect(ok).toBe(true);
    expect(canvas.width).toBe(64);
    expect(canvas.height).toBe(32);

    // vUv.y is 1 at the top of the image; without the row flip the green
    // channel gradient would be inverted.
    const topLeft = pixelAt(canvas, 0, 0);
    const bottomLeft = pixelAt(canvas, 0, 31);
    const topRight = pixelAt(canvas, 63, 0);

    expect(topLeft[1]).toBeGreaterThan(200); // green = vUv.y near 1
    expect(bottomLeft[1]).toBeLessThan(50); // green = vUv.y near 0
    expect(topLeft[0]).toBeLessThan(50); // red = vUv.x near 0
    expect(topRight[0]).toBeGreaterThan(200); // red = vUv.x near 1
    expect(topLeft[2]).toBeGreaterThan(55); // blue constant 0.25
    expect(topLeft[2]).toBeLessThan(75);
    expect(topLeft[3]).toBe(255);
  });

  it("handles consecutive captures at different sizes", async () => {
    const canvasA = document.createElement("canvas");
    const canvasB = document.createElement("canvas");

    expect(await captureMaterialToCanvas(gl, material, canvasA, 32, 16)).toBe(true);
    expect(await captureMaterialToCanvas(gl, material, canvasB, 48, 24)).toBe(true);

    expect(canvasA.width).toBe(32);
    expect(canvasA.height).toBe(16);
    expect(canvasB.width).toBe(48);
    expect(canvasB.height).toBe(24);

    // Both captures show the same gradient despite the shared target resizing.
    expect(pixelAt(canvasA, 0, 0)[1]).toBeGreaterThan(190);
    expect(pixelAt(canvasB, 0, 0)[1]).toBeGreaterThan(190);
    expect(pixelAt(canvasB, 0, 23)[1]).toBeLessThan(60);
  });

  it("restores the previously bound render target", async () => {
    const canvas = document.createElement("canvas");
    gl.setRenderTarget(null);
    await captureMaterialToCanvas(gl, material, canvas, 16, 16);
    expect(gl.getRenderTarget()).toBeNull();
  });
});
