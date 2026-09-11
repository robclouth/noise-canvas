import { WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRenderTargetBytesAsync } from "../async-readpixels";
import { createByteTarget } from "../snapshot-capture";

describe("asynchronous readback cleanup", () => {
  let renderer: WebGLRenderer;

  beforeEach(() => {
    renderer = new WebGLRenderer({ antialias: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    renderer.dispose();
  });

  it.each(["allocation", "storage", "read", "fence", "flush", "wait", "poll", "context loss", "copy"])(
    "restores bindings and releases resources after %s failure",
    async (failure) => {
      const target = createByteTarget(4, 4);
      const previous = createByteTarget(4, 4);
      const context = renderer.getContext();
      if (!(context instanceof WebGL2RenderingContext)) throw new Error("WebGL2 required");
      renderer.setRenderTarget(target);
      renderer.setRenderTarget(previous);
      const draw: WebGLFramebuffer | null = context.getParameter(context.DRAW_FRAMEBUFFER_BINDING);
      const read = context.createFramebuffer();
      const pack = context.createBuffer();
      context.bindFramebuffer(context.READ_FRAMEBUFFER, read);
      context.bindBuffer(context.PIXEL_PACK_BUFFER, pack);
      const createBuffer = vi.spyOn(context, "createBuffer");
      const createSync = vi.spyOn(context, "fenceSync");
      const deleteBuffer = vi.spyOn(context, "deleteBuffer");
      const deleteSync = vi.spyOn(context, "deleteSync");
      const fail = (): never => {
        throw new Error("injected failure");
      };
      switch (failure) {
        case "allocation":
          createBuffer.mockReturnValueOnce(null!);
          break;
        case "storage":
          vi.spyOn(context, "bufferData").mockImplementationOnce(fail);
          break;
        case "read":
          vi.spyOn(context, "readPixels").mockImplementationOnce(fail);
          break;
        case "fence":
          createSync.mockReturnValueOnce(null!);
          break;
        case "flush":
          vi.spyOn(context, "flush").mockImplementationOnce(fail);
          break;
        case "wait":
          vi.spyOn(context, "clientWaitSync").mockReturnValue(context.WAIT_FAILED);
          break;
        case "poll":
          vi.spyOn(context, "clientWaitSync").mockImplementationOnce(fail);
          break;
        case "context loss":
          vi.spyOn(context, "isContextLost").mockReturnValue(true);
          break;
        case "copy":
          vi.spyOn(context, "getBufferSubData").mockImplementationOnce(fail);
          break;
      }
      const assertBindings = (): void => {
        expect(renderer.getRenderTarget()).toBe(previous);
        expect(context.getParameter(context.DRAW_FRAMEBUFFER_BINDING)).toBe(draw);
        expect(context.getParameter(context.READ_FRAMEBUFFER_BINDING)).toBe(read);
        expect(context.getParameter(context.PIXEL_PACK_BUFFER_BINDING)).toBe(pack);
      };
      try {
        const pending = readRenderTargetBytesAsync(renderer, target, 0, 0, 4, 4);
        const rejected = expect(pending).rejects.toThrow();
        assertBindings();
        await rejected;
        assertBindings();
        const pbo = createBuffer.mock.results[0]?.value;
        const sync = createSync.mock.results[0]?.value;
        expect(deleteBuffer).toHaveBeenCalledTimes(pbo ? 1 : 0);
        expect(deleteSync).toHaveBeenCalledTimes(sync ? 1 : 0);
        if (pbo) expect(deleteBuffer).toHaveBeenCalledWith(pbo);
        if (sync) expect(deleteSync).toHaveBeenCalledWith(sync);
      } finally {
        vi.restoreAllMocks();
        context.bindBuffer(context.PIXEL_PACK_BUFFER, null);
        renderer.setRenderTarget(null);
        context.bindFramebuffer(context.READ_FRAMEBUFFER, null);
        context.deleteBuffer(pack);
        context.deleteFramebuffer(read);
        target.dispose();
        previous.dispose();
      }
    },
  );
});
