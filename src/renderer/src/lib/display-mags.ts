import {
  BufferAttribute,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RGBAFormat,
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

// Packed pixels one CPU upload batch may hold: 8192 wide by 512 rows is 64 MB
// of RGBA32F, small enough to stay transient and large enough that a whole
// file seeds in a handful of draws.
const UPLOAD_CHUNK_PIXELS = 8192 * 512;
const UPLOAD_CHUNK_WIDTH = 8192;

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

  private readonly uploadChunkPixels: number;

  constructor(file: PackedLayout, opts?: { uploadChunkPixels?: number }) {
    this.uploadChunkPixels = opts?.uploadChunkPixels ?? UPLOAD_CHUNK_PIXELS;
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
    this.scatter(gl, source, window.textureWidth, triplets);
    this.seeded = true;
  }

  /**
   * Encodes file packed ranges straight from the CPU array, in transient
   * upload batches, so the display can follow the packed state with no canvas
   * FBO alive. A patch into an unseeded texture is skipped: the full seed that
   * must follow reads the same packed state.
   */
  patchFromPacked(gl: WebGLRenderer, data: Float32Array, ranges: Uint32Array): void {
    if (!this.seeded) return;
    this.uploadRanges(gl, data, ranges);
  }

  /** Encodes the whole packed state from the CPU array. */
  seedFromPacked(gl: WebGLRenderer, data: Float32Array): void {
    this.uploadRanges(gl, data, Uint32Array.of(0, this.target.width * this.target.height));
    this.seeded = true;
  }

  private uploadRanges(gl: WebGLRenderer, data: Float32Array, ranges: Uint32Array): void {
    let rangeIndex = 0;
    let rangeOffset = 0;
    while (rangeIndex < ranges.length) {
      const triplets: number[] = [];
      let used = 0;
      let pieces = 0;
      while (rangeIndex < ranges.length && used < this.uploadChunkPixels) {
        const start = ranges[rangeIndex] + rangeOffset;
        const left = ranges[rangeIndex + 1] - rangeOffset;
        if (left <= 0) {
          rangeIndex += 2;
          rangeOffset = 0;
          continue;
        }
        const take = Math.min(left, this.uploadChunkPixels - used);
        triplets.push(start, take, used);
        pieces++;
        used += take;
        rangeOffset += take;
        if (rangeOffset === ranges[rangeIndex + 1]) {
          rangeIndex += 2;
          rangeOffset = 0;
        }
      }
      if (used === 0) break;

      const width = Math.min(used, UPLOAD_CHUNK_WIDTH);
      const height = Math.ceil(used / width);
      const chunk = new Float32Array(width * height * 4);
      for (let t = 0; t < pieces; t++) {
        const start = triplets[t * 3];
        const count = triplets[t * 3 + 1];
        const at = triplets[t * 3 + 2];
        chunk.set(data.subarray(start * 4, (start + count) * 4), at * 4);
      }

      const tex = new DataTexture(chunk, width, height, RGBAFormat, FloatType);
      tex.internalFormat = "RGBA32F";
      tex.minFilter = NearestFilter;
      tex.magFilter = NearestFilter;
      tex.needsUpdate = true;
      this.scatter(gl, tex, width, Uint32Array.from(triplets));
      tex.dispose();
    }
  }

  private scatter(gl: WebGLRenderer, source: Texture, srcWidth: number, triplets: Uint32Array): void {
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
    displayMagsMaterial.uniforms.srcWidth.value = srcWidth;

    const prevAutoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(this.target);
    gl.render(this.scene, this.camera);
    gl.setRenderTarget(null);
    gl.autoClear = prevAutoClear;

    displayMagsMaterial.uniforms.inputTex.value = null;
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
