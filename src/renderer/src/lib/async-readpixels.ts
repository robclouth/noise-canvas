import * as THREE from "three";

type PixelBuffer = Float32Array | Uint8Array;

/** Bytes one pixel-pack buffer of a readback holds at most; a larger read is split by rows. */
const READ_CHUNK_BYTES = 16 * 1024 * 1024;

/** A readback issued to the GPU: the rows it covers, its buffer and, once issued, its fence. */
type IssuedRead = { rows: number; pbo: WebGLBuffer; sync: WebGLSync | null };

/**
 * Core PBO readback: reads RGBA pixels from a render target into `buffer`
 * without blocking the main thread. The GL type (FLOAT / UNSIGNED_BYTE) is
 * derived from the buffer's kind. Every row is read from the target as it
 * stands at the call; a large read is split into chunks of rows, each
 * copied out in its own task, so no single copy holds a frame. Falls back to
 * a synchronous readback when PBOs are unavailable (WebGL1).
 */
async function readPixelsViaPbo(
  gl: THREE.WebGLRenderer,
  renderTarget: THREE.WebGLRenderTarget,
  x: number,
  y: number,
  width: number,
  height: number,
  buffer: PixelBuffer,
): Promise<PixelBuffer> {
  const glContext = gl.getContext();

  // Check if WebGL2 is available
  if (!("fenceSync" in glContext)) {
    // Fallback to synchronous readback for WebGL1
    gl.readRenderTargetPixels(renderTarget, x, y, width, height, buffer);
    return buffer;
  }

  const glType = buffer instanceof Float32Array ? glContext.FLOAT : glContext.UNSIGNED_BYTE;
  const rowBytes = width * 4 * buffer.BYTES_PER_ELEMENT;
  const rowsPerChunk = Math.max(1, Math.floor(READ_CHUNK_BYTES / Math.max(1, rowBytes)));

  const issued: IssuedRead[] = [];
  try {
    const readFramebuffer: WebGLFramebuffer | null = glContext.getParameter(glContext.READ_FRAMEBUFFER_BINDING);
    const drawFramebuffer: WebGLFramebuffer | null = glContext.getParameter(glContext.DRAW_FRAMEBUFFER_BINDING);
    const packBuffer: WebGLBuffer | null = glContext.getParameter(glContext.PIXEL_PACK_BUFFER_BINDING);
    try {
      const framebuffer = (gl.properties.get(renderTarget) as { __webglFramebuffer: WebGLFramebuffer })
        .__webglFramebuffer;
      glContext.bindFramebuffer(glContext.READ_FRAMEBUFFER, framebuffer);
      // Issue every read before yielding, so another capture can reuse the target.
      for (let row = 0; row < height; row += rowsPerChunk) {
        const rows = Math.min(rowsPerChunk, height - row);
        const pbo = glContext.createBuffer();
        if (!pbo) throw new Error("Failed to create PBO");
        const read: IssuedRead = { rows, pbo, sync: null };
        issued.push(read);
        glContext.bindBuffer(glContext.PIXEL_PACK_BUFFER, pbo);
        glContext.bufferData(glContext.PIXEL_PACK_BUFFER, rows * rowBytes, glContext.STREAM_READ);
        glContext.readPixels(x, y + row, width, rows, glContext.RGBA, glType, 0);
        read.sync = glContext.fenceSync(glContext.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!read.sync) throw new Error("Failed to create fence sync");
      }
      glContext.flush();
    } finally {
      glContext.bindFramebuffer(glContext.READ_FRAMEBUFFER, readFramebuffer);
      glContext.bindFramebuffer(glContext.DRAW_FRAMEBUFFER, drawFramebuffer);
      glContext.bindBuffer(glContext.PIXEL_PACK_BUFFER, packBuffer);
    }

    let at = 0;
    for (const read of issued) {
      if (!read.sync) throw new Error("Failed to create fence sync");
      await waitForFence(glContext, read.sync);
      if (glContext.isContextLost()) throw new Error("WebGL context lost during readback");
      const floats = read.rows * width * 4;
      const currentPackBuffer: WebGLBuffer | null = glContext.getParameter(glContext.PIXEL_PACK_BUFFER_BINDING);
      try {
        glContext.bindBuffer(glContext.PIXEL_PACK_BUFFER, read.pbo);
        glContext.getBufferSubData(glContext.PIXEL_PACK_BUFFER, 0, buffer.subarray(at, at + floats));
      } finally {
        glContext.bindBuffer(glContext.PIXEL_PACK_BUFFER, currentPackBuffer);
      }
      at += floats;
      if (issued.length > 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    for (const read of issued) {
      if (read.sync) glContext.deleteSync(read.sync);
      glContext.deleteBuffer(read.pbo);
    }
  }

  return buffer;
}

/** Resolves once the GPU has passed `fence`, checking once a frame. */
async function waitForFence(glContext: WebGL2RenderingContext, fence: WebGLSync): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const checkSync = (): void => {
      try {
        if (glContext.isContextLost()) throw new Error("WebGL context lost during readback");
        const status = glContext.clientWaitSync(fence, 0, 0);
        if (status === glContext.WAIT_FAILED) throw new Error("Failed to wait for readback fence");
        if (status === glContext.ALREADY_SIGNALED || status === glContext.CONDITION_SATISFIED) {
          resolve();
        } else {
          requestAnimationFrame(checkSync);
        }
      } catch (error) {
        reject(error);
      }
    };
    checkSync();
  });
}

/**
 * Reads float pixels from a WebGL render target asynchronously using WebGL2
 * Pixel Pack Buffers (PBO). This prevents blocking the main thread during
 * pixel readback operations.
 *
 * @param gl - The WebGL renderer
 * @param renderTarget - The render target to read from
 * @param x - X coordinate to start reading from
 * @param y - Y coordinate to start reading from
 * @param width - Width of the region to read
 * @param height - Height of the region to read
 * @returns Promise that resolves to a Float32Array containing the pixel data
 */
export async function readRenderTargetPixelsAsync(
  gl: THREE.WebGLRenderer,
  renderTarget: THREE.WebGLRenderTarget,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<Float32Array> {
  const buffer = new Float32Array(width * height * 4);
  await readPixelsViaPbo(gl, renderTarget, x, y, width, height, buffer);
  return buffer;
}

/**
 * Byte (RGBA8) variant of {@link readRenderTargetPixelsAsync}, for readbacks
 * destined for 2D canvas ImageData.
 */
export async function readRenderTargetBytesAsync(
  gl: THREE.WebGLRenderer,
  renderTarget: THREE.WebGLRenderTarget,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(width * height * 4);
  await readPixelsViaPbo(gl, renderTarget, x, y, width, height, buffer);
  return buffer;
}
