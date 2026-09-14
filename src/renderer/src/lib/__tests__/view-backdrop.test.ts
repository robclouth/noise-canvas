import { Color, Vector4 } from "three";
import { expect, it } from "vitest";
import { createGL } from "../../test/render-harness";
import { createByteTarget } from "../snapshot-capture";
import { ViewBackdrop } from "../view-backdrop";

it("restores nested target and clear state after a failed backdrop build", () => {
  const gl = createGL();
  const parent = createByteTarget(32, 24);
  const backdrop = new ViewBackdrop();
  try {
    gl.setRenderTarget(parent);
    gl.setViewport(2, 3, 12, 10);
    gl.setScissor(4, 5, 8, 6);
    gl.setScissorTest(true);
    gl.setClearColor(0x123456, 0.4);
    const colour = gl.getClearColor(new Color());
    const viewport = gl.getViewport(new Vector4());
    const scissor = gl.getScissor(new Vector4());
    const autoClear = gl.autoClear;
    expect(() =>
      backdrop.ensure(gl, 16, 12, () => {
        throw new Error("draw failed");
      }),
    ).toThrow("draw failed");
    expect(gl.getRenderTarget()).toBe(parent);
    expect(gl.getViewport(new Vector4())).toEqual(viewport);
    expect(gl.getScissor(new Vector4())).toEqual(scissor);
    expect(gl.getScissorTest()).toBe(true);
    expect(gl.getClearColor(new Color())).toEqual(colour);
    expect(gl.getClearAlpha()).toBe(0.4);
    expect(gl.autoClear).toBe(autoClear);
    let draws = 0;
    backdrop.ensure(gl, 16, 12, () => {
      draws++;
    });
    backdrop.ensure(gl, 16, 12, () => {
      draws++;
    });
    expect(draws).toBe(1);
    backdrop.ensure(gl, 20, 10, () => {
      draws++;
    });
    expect(draws).toBe(2);
    expect(backdrop.bytes).toBe(800);
  } finally {
    backdrop.dispose();
    expect(backdrop.bytes).toBe(0);
    parent.dispose();
    gl.dispose();
  }
});
