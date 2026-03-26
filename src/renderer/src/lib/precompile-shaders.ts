import { effects } from "@renderer/effects";
import { Camera, Mesh, PlaneGeometry, Scene, WebGLRenderer } from "three";

const DUMMY_GEOMETRY = new PlaneGeometry(1, 1);

/**
 * Pre-compiles all shader materials from the effects registry.
 * Uses synchronous compile() to avoid compileAsync() polling hangs that
 * occur when the page is reloaded mid-compilation (e.g. Electron dev reload).
 * @param renderer The main WebGLRenderer instance.
 */
export function precompileAllShaders(renderer: WebGLRenderer) {
  console.log("Starting shader pre-compilation...");

  const dummyScene = new Scene();
  const dummyCamera = new Camera();

  Object.values(effects).forEach((effect) => {
    effect.materials.forEach((material) => {
      // To compile a material, it must be attached to a mesh in a scene.
      const mesh = new Mesh(DUMMY_GEOMETRY, material);
      dummyScene.add(mesh);
    });
  });

  renderer.compile(dummyScene, dummyCamera);
}
