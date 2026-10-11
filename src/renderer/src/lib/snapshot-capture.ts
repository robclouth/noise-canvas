import {
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  Scene,
  UnsignedByteType,
  WebGLRenderer,
  WebGLRenderTarget,
  Vector4,
} from "three";
import { readRenderTargetBytesAsync } from "./async-readpixels";

/**
 * Shared fullscreen-quad resources reused for every snapshot capture. A single
 * render target is safe even when captures from different files interleave:
 * each capture issues its render and readPixels-into-PBO synchronously before
 * awaiting the GPU fence, so the commands are ordered on the GL stream.
 */
let quadScene: Scene | null = null;
let quadMesh: Mesh | null = null;
let quadCamera: OrthographicCamera | null = null;
let captureTarget: WebGLRenderTarget | null = null;

function ensureQuad(): { scene: Scene; mesh: Mesh; camera: OrthographicCamera } {
  if (!quadScene || !quadMesh || !quadCamera) {
    quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    quadCamera.position.z = 1;
    quadScene = new Scene();
    quadMesh = new Mesh(new PlaneGeometry(2, 2));
    quadScene.add(quadMesh);
  }
  return { scene: quadScene, mesh: quadMesh, camera: quadCamera };
}

function ensureCaptureResources(width: number, height: number): WebGLRenderTarget {
  if (!captureTarget) {
    captureTarget = createByteTarget(width, height);
  } else if (captureTarget.width !== width || captureTarget.height !== height) {
    captureTarget.setSize(width, height);
  }
  return captureTarget;
}

/**
 * An 8-bit RGBA render target with no color-space conversion, so a raw shader's
 * output bytes reach the readback untouched.
 */
export function createByteTarget(width: number, height: number): WebGLRenderTarget {
  return new WebGLRenderTarget(width, height, {
    type: UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: NoColorSpace,
  });
}

/**
 * Renders `materials` as fullscreen quads into `target`, in order, and reads
 * the result back asynchronously (PBO + fence). Several materials are how an
 * overlaid stack is captured: each one's own blending sums it into the picture
 * the ones before it left. Rows run bottom-to-top, the order readPixels
 * returns them in.
 */
export async function renderMaterialToBytes(
  gl: WebGLRenderer,
  materials: RawShaderMaterial | RawShaderMaterial[],
  target: WebGLRenderTarget,
): Promise<Uint8Array> {
  const { scene, mesh, camera } = ensureQuad();
  const list = Array.isArray(materials) ? materials : [materials];
  return renderCompositionToBytes(
    gl,
    () => {
      for (const material of list) {
        mesh.material = material;
        gl.render(scene, camera);
      }
    },
    target,
  );
}

/** Draws a prepared composition and issues its PBO read before waiting for the fence. */
export async function renderCompositionToBytes(
  gl: WebGLRenderer,
  draw: () => void,
  target: WebGLRenderTarget,
): Promise<Uint8Array> {
  drawCompositionToTarget(gl, draw, target);
  return readRenderTargetBytesAsync(gl, target, 0, 0, target.width, target.height);
}

/** Draws synchronously into a target and restores the caller's graphics state. */
export function drawCompositionToTarget(gl: WebGLRenderer, draw: () => void, target: WebGLRenderTarget): void {
  const context = gl.getContext();
  const readTarget = "READ_FRAMEBUFFER" in context ? context.READ_FRAMEBUFFER : context.FRAMEBUFFER;
  const drawTarget = "DRAW_FRAMEBUFFER" in context ? context.DRAW_FRAMEBUFFER : context.FRAMEBUFFER;
  const prevReadFramebuffer: WebGLFramebuffer | null = context.getParameter(
    "READ_FRAMEBUFFER_BINDING" in context ? context.READ_FRAMEBUFFER_BINDING : context.FRAMEBUFFER_BINDING,
  );
  const prevDrawFramebuffer: WebGLFramebuffer | null = context.getParameter(context.FRAMEBUFFER_BINDING);
  const prevTarget = gl.getRenderTarget();
  const prevAutoClear = gl.autoClear;
  const viewport = gl.getViewport(new Vector4());
  const scissor = gl.getScissor(new Vector4());
  const scissorTest = gl.getScissorTest();
  try {
    gl.setRenderTarget(target);
    gl.setScissorTest(false);
    gl.autoClear = false;
    gl.clear(true, false, false);
    draw();
  } finally {
    gl.autoClear = prevAutoClear;
    gl.setViewport(viewport);
    gl.setScissor(scissor);
    gl.setScissorTest(scissorTest);
    // Last, so a capture nested inside another hands the outer target back
    // with that target's own viewport rather than the canvas's.
    gl.setRenderTarget(prevTarget);
    context.bindFramebuffer(readTarget, prevReadFramebuffer);
    context.bindFramebuffer(drawTarget, prevDrawFramebuffer);
  }
}

/**
 * Renders `material` as a fullscreen quad at the given pixel size and copies
 * the result into a 2D `canvas`, resizing it to match. The readback is
 * asynchronous (PBO + fence), so the main thread is not stalled on the GPU.
 * Returns false when the canvas has no usable 2D context.
 */
export async function captureMaterialToCanvas(
  gl: WebGLRenderer,
  materials: RawShaderMaterial | RawShaderMaterial[],
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): Promise<boolean> {
  return captureCompositionToCanvas(
    gl,
    () => {
      const { scene, mesh, camera } = ensureQuad();
      for (const material of Array.isArray(materials) ? materials : [materials]) {
        mesh.material = material;
        gl.render(scene, camera);
      }
    },
    canvas,
    width,
    height,
  );
}

/** Captures a prepared view into its DOM still. */
export async function captureCompositionToCanvas(
  gl: WebGLRenderer,
  draw: () => void,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  canPublish: () => boolean = () => true,
): Promise<boolean> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  const target = ensureCaptureResources(width, height);
  const pixels = await renderCompositionToBytes(gl, draw, target);
  if (!canPublish()) return false;

  canvas.width = width;
  canvas.height = height;
  const image = ctx.createImageData(width, height);
  // readPixels rows run bottom-to-top; flip into the canvas's top-down order.
  const rowBytes = width * 4;
  for (let row = 0; row < height; row++) {
    const src = (height - 1 - row) * rowBytes;
    image.data.set(pixels.subarray(src, src + rowBytes), row * rowBytes);
  }
  ctx.putImageData(image, 0, 0);
  return true;
}
