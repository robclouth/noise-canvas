import { effects } from "@renderer/effects";
import type { EffectType } from "@renderer/effects/types";
import { Camera, GLSL3, Mesh, PlaneGeometry, RawShaderMaterial, Scene, WebGLRenderer } from "three";
import displayFrag from "../glsl/display.frag";
import maskUpdateFrag from "../glsl/mask-update.frag";
import modulatorFrag from "../glsl/modulator.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { host } from "./host";
import type { ShaderDescriptor, WarmupMessage } from "./shader-warmup-types";

const DUMMY_GEOMETRY = new PlaneGeometry(2, 2);

/**
 * Programs linked per compileAsync call. Linking the whole set in one call is
 * the fastest wall-clock route -- the driver translates the batch in parallel,
 * roughly twice as fast as one program at a time -- but the call blocks the main
 * thread for a moment as it hands each program over, and reports nothing until
 * the last one lands. Small batches keep both the hitch and the gap between
 * progress ticks short while retaining most of the parallelism.
 */
const LINK_BATCH_SIZE = 6;

const auxiliaryMaterials = new Map<string, RawShaderMaterial>();

/**
 * A throwaway material whose shader source matches a per-instance material
 * created elsewhere (display in file-renderer, modulator in modulator-view, mask
 * in stroke-renderer). Identical source + glslVersion yields the same program
 * cache key, so linking this warms the program the real material reuses. They
 * are intentionally never disposed: disposing would release the cached program
 * and undo the warmup.
 */
function auxiliaryMaterial(frag: string): RawShaderMaterial {
  let material = auxiliaryMaterials.get(frag);
  if (!material) {
    material = new RawShaderMaterial({
      vertexShader: passThroughVert,
      fragmentShader: frag,
      glslVersion: GLSL3,
    });
    auxiliaryMaterials.set(frag, material);
  }
  return material;
}

function collectEffectMaterials(): RawShaderMaterial[] {
  const materials: RawShaderMaterial[] = [];
  for (const effect of Object.values(effects)) {
    materials.push(...effect.materials);
  }
  return materials;
}

/**
 * Every effect's materials, with the named effects first. An effect the brush
 * already holds is the one the next stroke needs, so it is linked before the
 * effects the user may never reach for this session.
 */
function effectMaterialsByPriority(priority: readonly EffectType[]): RawShaderMaterial[] {
  const wanted = new Set(priority);
  const first: RawShaderMaterial[] = [];
  const rest: RawShaderMaterial[] = [];
  for (const [key, effect] of Object.entries(effects)) {
    (wanted.has(key as EffectType) ? first : rest).push(...effect.materials);
  }
  return [...first, ...rest];
}

async function linkInBatches(
  renderer: WebGLRenderer,
  materials: RawShaderMaterial[],
  onLinked?: (done: number) => void,
): Promise<void> {
  const camera = new Camera();
  for (let i = 0; i < materials.length; i += LINK_BATCH_SIZE) {
    const scene = new Scene();
    for (const material of materials.slice(i, i + LINK_BATCH_SIZE)) {
      scene.add(new Mesh(DUMMY_GEOMETRY, material));
    }
    // The synchronous path is kept for dev because an Electron page reload
    // mid-compile can leave the async completion poll hanging.
    if (import.meta.env.PROD) {
      await renderer.compileAsync(scene, camera);
    } else {
      renderer.compile(scene, camera);
    }
    onLinked?.(Math.min(i + LINK_BATCH_SIZE, materials.length));
    // Let the frame that shows this progress paint before the next batch takes
    // the main thread again.
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/**
 * Links the one shader the app needs before it can put anything on screen: the
 * spectrogram display. Everything else — the stroke mask, the modulator preview,
 * the effects — is only reached after the user acts, so it is left to the
 * background pass and the app opens without waiting for it.
 */
export async function precompileDisplayShader(renderer: WebGLRenderer): Promise<void> {
  const startTime = performance.now();
  await linkInBatches(renderer, [auxiliaryMaterial(displayFrag)]);
  console.log(`Display shader linking finished in ${Math.round(performance.now() - startTime)}ms.`);
}

/**
 * Links the stroke mask, the modulator preview and every effect program. On
 * Windows/ANGLE this is the whole cost of getting an effect ready — tens of
 * seconds for the set, dominated by the shared sampling code that every effect
 * inlines once per call site — so it runs in the background with the app already
 * usable. compileAsync hands the translation to a driver thread via
 * KHR_parallel_shader_compile, which keeps the main thread at frame rate
 * throughout.
 *
 * @param renderer The main WebGLRenderer instance.
 * @param priority Effects to link first, e.g. the ones the brush already holds.
 */
export async function precompileRemainingShaders(
  renderer: WebGLRenderer,
  priority: readonly EffectType[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const startTime = performance.now();
  const materials = [
    auxiliaryMaterial(maskUpdateFrag),
    auxiliaryMaterial(modulatorFrag),
    ...effectMaterialsByPriority(priority),
  ];
  onProgress?.(0, materials.length);
  await linkInBatches(renderer, materials, (done) => onProgress?.(done, materials.length));
  console.log(`Effect shader linking finished in ${Math.round(performance.now() - startTime)}ms.`);
}

function collectEffectShaderDescriptors(): ShaderDescriptor[] {
  const seen = new Set<string>();
  const descriptors: ShaderDescriptor[] = [];
  for (const material of collectEffectMaterials()) {
    const key = `${material.vertexShader} ${material.fragmentShader}`;
    if (seen.has(key)) continue;
    seen.add(key);
    descriptors.push({
      vertexShader: material.vertexShader,
      fragmentShader: material.fragmentShader,
      glslVersion: material.glslVersion,
      blending: material.blending,
      transparent: material.transparent,
      depthTest: material.depthTest,
      depthWrite: material.depthWrite,
      side: material.side,
      premultipliedAlpha: material.premultipliedAlpha,
    });
  }
  return descriptors;
}

/**
 * Warms each effect's backend pipeline state -- the cost a driver that compiles
 * pipeline state lazily otherwise defers to the first stroke -- on a background
 * worker.
 *
 * The worker compiles on its own OffscreenCanvas GL context, so the cost lands
 * off the main thread. The shared GPU-process shader cache means the programs it
 * compiles are reused by the main canvas. The exact shader source and render
 * state are harvested from the live materials so the worker's programs match
 * byte-for-byte (platform defines and resolved #includes are already baked into
 * the source strings).
 *
 * Skipped on Windows, where linking already pays the whole compile: measured
 * there, the worker re-links the same programs out of the GPU process cache for
 * no gain, and its draw-and-finish loop is the one thing in startup that does
 * stall compositing. onDone is always called once when warming finishes, fails
 * or is skipped. If OffscreenCanvas or workers are unavailable, warmup is
 * skipped and effects compile lazily on first use.
 */
export function warmEffectPipelines(callbacks: {
  onProgress?: (done: number, total: number) => void;
  onDone?: () => void;
}): void {
  const finish = () => callbacks.onDone?.();

  if (host.env.platform === "win32") {
    finish();
    return;
  }

  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    console.warn("Shader warmup skipped: OffscreenCanvas/Worker unavailable. Effects will compile on first use.");
    finish();
    return;
  }

  const descriptors = collectEffectShaderDescriptors();
  callbacks.onProgress?.(0, descriptors.length);

  const startTime = performance.now();
  const worker = new Worker(new URL("./shader-warmup.worker.ts", import.meta.url), { type: "module" });

  worker.onmessage = (event: MessageEvent<WarmupMessage>) => {
    const message = event.data;
    if (message.type === "progress") {
      callbacks.onProgress?.(message.done, message.total);
      return;
    }
    if (message.type === "done") {
      console.log(
        `Effect pipeline warmup (worker) finished in ${Math.round(performance.now() - startTime)}ms ` +
          `(${message.succeeded}/${message.count} drawn, ${message.failed} failed, floatRenderable=${message.floatRenderable}).`,
      );
      if (message.errors.length) console.warn("Shader warmup draw errors:", message.errors);
    } else {
      console.warn("Shader warmup worker error:", message.message);
    }
    worker.terminate();
    finish();
  };
  worker.onerror = (event) => {
    console.warn("Shader warmup worker failed:", event.message);
    worker.terminate();
    finish();
  };

  // Hand work to the worker only once the browser goes idle, so the startup
  // file-renders finish first -- the GPU process can't composite once the
  // compiles start. The timeout bounds the wait if the app stays busy.
  const start = () => requestAnimationFrame(() => worker.postMessage(descriptors));
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(start, { timeout: 2000 });
  } else {
    requestAnimationFrame(() => requestAnimationFrame(start));
  }
}
