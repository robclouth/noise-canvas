import {
  BufferAttribute,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import { patchMaterial } from "../components/patch-material";

// A unit quad the patch material's vertex shader stretches over each range.
const PATCH_QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const PATCH_QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);

/**
 * Scatters `values`, compact in the order of `pixelRanges`, into each target
 * at those pixels, leaving every other pixel as it was. False when the ranges
 * name no pixel.
 */
export function scatterIntoTargets(
  gl: WebGLRenderer,
  values: Float32Array,
  pixelRanges: Uint32Array,
  targets: readonly WebGLRenderTarget[],
): boolean {
  let patchPixels = 0;
  let numRanges = 0;
  for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
    if (pixelRanges[i + 1] === 0) continue;
    patchPixels += pixelRanges[i + 1];
    numRanges++;
  }
  if (patchPixels === 0 || targets.length === 0) return false;
  if (values.length !== patchPixels * 4) throw new Error("the patch values do not match the ranges");

  // Where each range sits in the compact block, so the shader can scatter it back.
  const instances = new Uint32Array(numRanges * 3);
  let srcPixel = 0;
  let inst = 0;
  for (let i = 0; i + 1 < pixelRanges.length; i += 2) {
    const start = pixelRanges[i];
    const count = pixelRanges[i + 1];
    if (count === 0) continue;
    instances[inst * 3] = start;
    instances[inst * 3 + 1] = count;
    instances[inst * 3 + 2] = srcPixel;
    srcPixel += count;
    inst++;
  }

  const patchWidth = Math.min(targets[0].width, patchPixels);
  const patchHeight = Math.ceil(patchPixels / patchWidth);
  let padded = values;
  if (values.length !== patchWidth * patchHeight * 4) {
    padded = new Float32Array(patchWidth * patchHeight * 4);
    padded.set(values);
  }
  const patchTex = new DataTexture(padded, patchWidth, patchHeight, RGBAFormat, FloatType);
  patchTex.needsUpdate = true;
  gl.initTexture(patchTex);

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(PATCH_QUAD_POSITIONS, 3));
  geometry.setIndex(new BufferAttribute(PATCH_QUAD_INDICES, 1));
  geometry.setAttribute("aRange", new InstancedBufferAttribute(instances, 3));
  geometry.instanceCount = numRanges;

  patchMaterial.uniforms.patchTex.value = patchTex;
  patchMaterial.uniforms.patchWidth.value = patchWidth;

  const mesh = new Mesh(geometry, patchMaterial);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);

  // Only the patched pixels are drawn, so the rest of each target must
  // survive the render.
  const prevAutoClear = gl.autoClear;
  gl.autoClear = false;
  for (const target of targets) {
    patchMaterial.uniforms.destWidth.value = target.width;
    patchMaterial.uniforms.destHeight.value = target.height;
    gl.setRenderTarget(target);
    gl.render(scene, camera);
  }
  gl.setRenderTarget(null);
  gl.autoClear = prevAutoClear;

  patchMaterial.uniforms.patchTex.value = null;
  geometry.dispose();
  patchTex.dispose();
  return true;
}
