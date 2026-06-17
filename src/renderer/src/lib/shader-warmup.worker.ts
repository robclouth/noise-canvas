import {
  Camera,
  FloatType,
  Mesh,
  NearestFilter,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import type { ShaderDescriptor, WarmupMessage } from "./shader-warmup-types";

const worker = self as unknown as Worker;

/**
 * Compiles every effect shader on this worker's own OffscreenCanvas GL context.
 * The expensive driver work (pipeline-state compilation) happens on the worker
 * thread, leaving the main UI thread responsive. Because Chromium's GPU process
 * shares its shader cache across contexts, the programs compiled here are reused
 * by the main canvas when the user first paints with each effect.
 *
 * Each material is drawn once into a render target matching the painting FBOs
 * (RGBA, FloatType, NearestFilter, depth buffer) so the compiled pipeline state
 * matches. The materials carry no uniforms: pipeline state depends on the shader
 * source and render state, not uniform values, and omitting uniforms avoids the
 * struct-array upload that an empty default would crash on.
 */
type WarmStats = { succeeded: number; failed: number; floatRenderable: boolean; errors: string[] };

// Minimal idle window between compiles. The shared GPU process can't composite
// while it compiles a pipeline, so this is the only chance it gets to repaint
// the progress bar between shaders -- without it the bar freezes at 0 and jumps
// straight to done. Kept small since it can't make animation smooth, only let
// the step-wise progress update land.
const COMPILE_GAP_MS = 48;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function warmShaders(descriptors: ShaderDescriptor[]): Promise<WarmStats> {
  const canvas = new OffscreenCanvas(4, 4);
  const renderer = new WebGLRenderer({ canvas });
  const gl = renderer.getContext();
  const floatRenderable = gl.getExtension("EXT_color_buffer_float") !== null;

  const target = new WebGLRenderTarget(4, 4, {
    format: RGBAFormat,
    type: FloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });
  const scene = new Scene();
  const camera = new Camera();
  const mesh = new Mesh(new PlaneGeometry(2, 2));
  mesh.frustumCulled = false;
  scene.add(mesh);
  renderer.setRenderTarget(target);

  const stats: WarmStats = { succeeded: 0, failed: 0, floatRenderable, errors: [] };

  for (const descriptor of descriptors) {
    // Pause before every compile, including the first, so the GPU process gets
    // an idle window to composite the overlay before it's saturated again.
    await delay(COMPILE_GAP_MS);
    const material = new RawShaderMaterial({
      vertexShader: descriptor.vertexShader,
      fragmentShader: descriptor.fragmentShader,
      glslVersion: descriptor.glslVersion,
    });
    material.blending = descriptor.blending;
    material.transparent = descriptor.transparent;
    material.depthTest = descriptor.depthTest;
    material.depthWrite = descriptor.depthWrite;
    material.side = descriptor.side;
    material.premultipliedAlpha = descriptor.premultipliedAlpha;
    mesh.material = material;
    try {
      renderer.render(scene, camera);
      // Block the worker until the GPU has actually finished this pipeline
      // compile, so the following gap is real idle time for the GPU process
      // rather than the next compile queuing up behind this one.
      gl.finish();
      stats.succeeded++;
    } catch (err) {
      stats.failed++;
      if (stats.errors.length < 3) stats.errors.push(err instanceof Error ? err.message : String(err));
    }
    material.dispose();
    worker.postMessage({ type: "progress", done: stats.succeeded + stats.failed, total: descriptors.length });
  }

  target.dispose();
  renderer.dispose();
  return stats;
}

worker.onmessage = async (event: MessageEvent<ShaderDescriptor[]>) => {
  let result: WarmupMessage;
  try {
    const stats = await warmShaders(event.data);
    result = { type: "done", count: event.data.length, ...stats };
  } catch (err) {
    result = { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
  worker.postMessage(result);
};
