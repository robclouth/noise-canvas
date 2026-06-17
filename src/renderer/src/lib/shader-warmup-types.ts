import type { Blending, GLSLVersion, Side } from "three";

/**
 * A self-contained description of one shader program, harvested from a material
 * on the main thread and sent to the warmup worker. The worker rebuilds a
 * byte-identical RawShaderMaterial from this so the program/pipeline it compiles
 * matches the one the main thread will use (the GPU-process shader cache is
 * shared across contexts, so the main thread's first use becomes a cache hit).
 * Source strings are taken verbatim from the live materials, so platform defines
 * and resolved #includes are already baked in.
 */
export type ShaderDescriptor = {
  vertexShader: string;
  fragmentShader: string;
  glslVersion: GLSLVersion | null;
  blending: Blending;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
  side: Side;
  premultipliedAlpha: boolean;
};

export type WarmupMessage =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; count: number; succeeded: number; failed: number; floatRenderable: boolean; errors: string[] }
  | { type: "error"; message: string };
