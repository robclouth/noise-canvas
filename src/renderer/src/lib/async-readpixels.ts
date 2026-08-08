import * as THREE from "three";

type PixelBuffer = Float32Array | Uint8Array;

/**
 * Core PBO readback: reads RGBA pixels from a render target into `buffer`
 * without blocking the main thread. The GL type (FLOAT / UNSIGNED_BYTE) is
 * derived from the buffer's kind. Falls back to a synchronous readback when
 * PBOs are unavailable (WebGL1).
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
  const glContext = gl.getContext() as WebGL2RenderingContext;

  // Check if WebGL2 is available
  if (!glContext.createBuffer || !glContext.fenceSync) {
    // Fallback to synchronous readback for WebGL1
    gl.readRenderTargetPixels(renderTarget, x, y, width, height, buffer);
    return buffer;
  }

  const glType = buffer instanceof Float32Array ? glContext.FLOAT : glContext.UNSIGNED_BYTE;

  // Create a Pixel Pack Buffer Object (PBO)
  const pbo = glContext.createBuffer();
  if (!pbo) {
    throw new Error("Failed to create PBO");
  }

  const byteSize = buffer.byteLength;

  // Bind the FBO for reading
  const framebuffer = (gl.properties.get(renderTarget) as { __webglFramebuffer: WebGLFramebuffer }).__webglFramebuffer;
  glContext.bindFramebuffer(glContext.FRAMEBUFFER, framebuffer);

  // Bind PBO and allocate storage
  glContext.bindBuffer(glContext.PIXEL_PACK_BUFFER, pbo);
  glContext.bufferData(glContext.PIXEL_PACK_BUFFER, byteSize, glContext.STREAM_READ);

  // Initiate async readPixels into the PBO
  glContext.readPixels(
    x,
    y,
    width,
    height,
    glContext.RGBA,
    glType,
    0, // offset into PBO
  );

  // Create a fence sync object to check when GPU is done
  const sync = glContext.fenceSync(glContext.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) {
    glContext.deleteBuffer(pbo);
    throw new Error("Failed to create fence sync");
  }

  // Flush to ensure the commands are submitted
  glContext.flush();

  // Unbind the PBO
  glContext.bindBuffer(glContext.PIXEL_PACK_BUFFER, null);
  glContext.bindFramebuffer(glContext.FRAMEBUFFER, null);

  // Wait for the GPU to finish (non-blocking poll)
  await new Promise<void>((resolve) => {
    const checkSync = () => {
      const status = glContext.getSyncParameter(sync, glContext.SYNC_STATUS);
      if (status === glContext.SIGNALED) {
        resolve();
      } else {
        // Check again on next frame
        requestAnimationFrame(checkSync);
      }
    };
    checkSync();
  });

  // Read data from PBO into our buffer
  glContext.bindBuffer(glContext.PIXEL_PACK_BUFFER, pbo);
  glContext.getBufferSubData(glContext.PIXEL_PACK_BUFFER, 0, buffer);
  glContext.bindBuffer(glContext.PIXEL_PACK_BUFFER, null);

  // Cleanup
  glContext.deleteSync(sync);
  glContext.deleteBuffer(pbo);

  return buffer;
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
