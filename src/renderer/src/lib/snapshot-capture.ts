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
 * Renders `material` as a fullscreen quad into `target` and reads the result
 * back asynchronously (PBO + fence). Rows run bottom-to-top, the order
 * readPixels returns them in.
 */
export async function renderMaterialToBytes(
  gl: WebGLRenderer,
  material: RawShaderMaterial,
  target: WebGLRenderTarget,
): Promise<Uint8Array> {
  const { scene, mesh, camera } = ensureQuad();
  mesh.material = material;

  const prevTarget = gl.getRenderTarget();
  gl.setRenderTarget(target);
  gl.render(scene, camera);
  gl.setRenderTarget(prevTarget);

  return readRenderTargetBytesAsync(gl, target, 0, 0, target.width, target.height);
}

/**
 * Renders `material` as a fullscreen quad at the given pixel size and copies
 * the result into a 2D `canvas`, resizing it to match. The readback is
 * asynchronous (PBO + fence), so the main thread is not stalled on the GPU.
 * Returns false when the canvas has no usable 2D context.
 */
export async function captureMaterialToCanvas(
  gl: WebGLRenderer,
  material: RawShaderMaterial,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): Promise<boolean> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  const target = ensureCaptureResources(width, height);
  const pixels = await renderMaterialToBytes(gl, material, target);

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
