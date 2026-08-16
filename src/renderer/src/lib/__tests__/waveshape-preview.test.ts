import { describe, expect, it } from "vitest";

import shaderSource from "../../glsl/waveshape-effect.frag?raw";
import previewSource from "../../components/effect-views/waveshape-effect.tsx?raw";

/**
 * The Waveshape card draws its transfer curve in TypeScript while the effect
 * runs in GLSL. The preview covers inputs down to −1.5, where `Math.min` and
 * JavaScript's `%` disagree with `clamp` and GLSL's floored `mod`.
 */

/** The preview's shapeFn, lifted out of the component. */
function preview(M: number, mode: number, drive: number): number {
  const x = M * drive;
  switch (mode) {
    case 0:
      return Math.tanh(x);
    case 1:
      return Math.min(Math.max(x, 0), 1);
    case 2:
      return Math.abs(x);
    case 3: {
      const a = Math.abs(x);
      const m = a % 2.0;
      return m > 1.0 ? 2.0 - m : m;
    }
    case 4:
      return x - Math.floor(x);
    case 5:
      return Math.abs(Math.sin(x));
    default:
      return x;
  }
}

/** What the shader computes for the same input. */
function shader(M: number, mode: number, drive: number): number {
  const x = M * drive;
  const glslMod = (a: number, b: number) => a - b * Math.floor(a / b);
  switch (mode) {
    case 0:
      return Math.tanh(x);
    case 1:
      return Math.min(Math.max(x, 0), 1); // clamp(x, 0.0, 1.0)
    case 2:
      return Math.abs(x);
    case 3: {
      const m = glslMod(Math.abs(x), 2.0);
      return m > 1.0 ? 2.0 - m : m;
    }
    case 4:
      return glslMod(x, 1.0);
    default:
      return Math.abs(Math.sin(x));
  }
}

describe("waveshape preview", () => {
  it("matches the shader across the range the card draws", () => {
    for (let mode = 0; mode <= 5; mode++) {
      for (let m = -1.5; m <= 1.5; m += 0.05) {
        expect(preview(m, mode, 1)).toBeCloseTo(shader(m, mode, 1), 6);
      }
    }
  });

  it("uses clamp and a floored mod, as the shader does", () => {
    expect(shaderSource).toContain("clamp(x, 0.0, 1.0)");
    expect(shaderSource).toContain("mod(x, 1.0)");
    expect(previewSource).toContain("Math.min(Math.max(x, 0), 1)");
    expect(previewSource).toContain("x - Math.floor(x)");
  });
});
