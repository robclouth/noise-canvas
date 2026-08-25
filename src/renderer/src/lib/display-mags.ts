import {
  BufferAttribute,
  DynamicDrawUsage,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RGFormat,
  Scene,
  Texture,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { displayMagsMaterial } from "../components/display-mags-material";
import type { PixelRangeList } from "./range-quads";
import { mapWindowRangesToFile, type PackedLayout, type WindowLayout } from "./window-layout";

const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

/**
 * The file-sized RG16F dB magnitudes texture the display reads as its
 * committed base. Owned by the file view rather than the stroke renderer, so
 * its content survives the renderer rebuilding at another window: a refresh
 * scatters only the ranges it is given and leaves every other pixel standing.
 */
export class DisplayMags {
  private readonly target: WebGLRenderTarget;
  private readonly scene = new Scene();
  private readonly mesh: Mesh;
  private readonly geometry = new InstancedBufferGeometry();
  private attribute: InstancedBufferAttribute;
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private seeded = false;

  constructor(file: PackedLayout) {
    this.target = new WebGLRenderTarget(file.textureWidth, file.textureHeight, {
      format: RGFormat,
      type: HalfFloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.geometry.setAttribute("position", new BufferAttribute(QUAD_POSITIONS, 3));
    this.geometry.setIndex(new BufferAttribute(QUAD_INDICES, 1));
    this.attribute = this.createAttribute(64);
    this.mesh = new Mesh(this.geometry, displayMagsMaterial);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.camera.position.z = 1;
  }

  private createAttribute(capacity: number): InstancedBufferAttribute {
    const attribute = new InstancedBufferAttribute(new Uint32Array(capacity * 3), 3);
    attribute.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("aRange", attribute);
    return attribute;
  }

  /**
   * Re-encodes `ranges` (window packed pixels) of the window canvas into their
   * file positions. Leaves the render target unbound.
   */
  refreshFrom(gl: WebGLRenderer, source: Texture, window: WindowLayout, ranges: PixelRangeList): void {
    const triplets = mapWindowRangesToFile(window, ranges.ranges, ranges.count);
    const count = triplets.length / 3;
    if (count === 0) return;

    const capacity = this.attribute.array.length / 3;
    if (count > capacity) {
      this.attribute = this.createAttribute(Math.max(count, capacity * 2));
    }
    (this.attribute.array as Uint32Array).set(triplets);
    this.attribute.clearUpdateRanges();
    this.attribute.addUpdateRange(0, count * 3);
    this.attribute.needsUpdate = true;
    this.geometry.instanceCount = count;

    displayMagsMaterial.uniforms.inputTex.value = source;
    displayMagsMaterial.uniforms.destWidth.value = this.target.width;
    displayMagsMaterial.uniforms.destHeight.value = this.target.height;
    displayMagsMaterial.uniforms.srcWidth.value = window.textureWidth;

    const prevAutoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(this.target);
    gl.render(this.scene, this.camera);
    gl.setRenderTarget(null);
    gl.autoClear = prevAutoClear;

    displayMagsMaterial.uniforms.inputTex.value = null;
    this.seeded = true;
  }

  /** The texture to bind as the display's committed base; null until seeded. */
  texture(): Texture | null {
    return this.seeded ? this.target.texture : null;
  }

  texelCount(): number {
    return this.target.width * this.target.height;
  }

  dispose(): void {
    this.target.dispose();
    this.geometry.dispose();
  }
}
