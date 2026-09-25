import {
  BufferAttribute,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  Texture,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { gatherMaterial } from "../components/gather-material";
import { patchMaterial } from "../components/patch-material";
import { blockPixelRanges, blockTexels, PACKED_BYTES_PER_TEXEL, type BlockGrid } from "./block-grid";
import { fileRangesToView, type CanvasView } from "./canvas-view";
import { ANALYSIS_MAX_TEXTURE_SIZE } from "./constants";

const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

const DEFAULT_PAGE_BYTES = 128 * 1024 * 1024;

/**
 * GPU home of a file's committed block texels. Each block lives in a
 * fixed-size slot inside a page texture; slots are claimed under a byte
 * budget and the least recently used block leaves when every slot is taken.
 * Blocks move between their slots and a view's packed layout by GPU range
 * copies, so composing a view or folding a painted block back costs the
 * block's texels, not the file's.
 */
export class BlockSlotCache {
  readonly grid: BlockGrid;
  private readonly gl: WebGLRenderer;
  private readonly slotTexels: number;
  private readonly capacity: number;
  private readonly pageSlots: number;
  private readonly pageWidth: number;
  private readonly pageHeight: number;
  private readonly pages: Array<WebGLRenderTarget | null> = [];
  private readonly slotOf = new Map<number, number>();
  private readonly blockOf: Int32Array;
  private readonly lastUse: Float64Array;
  private tick = 0;
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  // One upload texture per patch shape, and the buffer a block whose texels
  // do not fill the texture's last row is staged in.
  private readonly uploads = new Map<string, DataTexture>();
  private staging: Float32Array | null = null;

  constructor(gl: WebGLRenderer, grid: BlockGrid, maxBytes: number, pageBytes = DEFAULT_PAGE_BYTES) {
    this.gl = gl;
    this.grid = grid;
    this.slotTexels = blockTexels(grid, 0);
    const slotBytes = this.slotTexels * PACKED_BYTES_PER_TEXEL;
    this.capacity = Math.min(Math.max(1, Math.floor(maxBytes / slotBytes)), grid.blockCount);
    const maxPageSlots = Math.max(
      1,
      Math.floor((ANALYSIS_MAX_TEXTURE_SIZE * ANALYSIS_MAX_TEXTURE_SIZE) / this.slotTexels),
    );
    this.pageSlots = Math.min(Math.max(1, Math.floor(pageBytes / slotBytes)), maxPageSlots, this.capacity);
    const pageTexels = this.pageSlots * this.slotTexels;
    this.pageWidth = Math.min(ANALYSIS_MAX_TEXTURE_SIZE, pageTexels);
    this.pageHeight = Math.ceil(pageTexels / this.pageWidth);
    this.blockOf = new Int32Array(this.capacity).fill(-1);
    this.lastUse = new Float64Array(this.capacity);
    this.camera.position.z = 1;
  }

  /** Slots the cache can hold at once. */
  get slotCount(): number {
    return this.capacity;
  }

  /** Slots no block holds yet. */
  get freeSlots(): number {
    return this.capacity - this.slotOf.size;
  }

  /** Bytes the allocated page textures hold. */
  get allocatedBytes(): number {
    let pages = 0;
    for (const page of this.pages) if (page) pages++;
    return pages * this.pageWidth * this.pageHeight * PACKED_BYTES_PER_TEXEL;
  }

  /** True when the block's texels are in a slot. */
  has(block: number): boolean {
    return this.slotOf.has(block);
  }

  /** The given blocks that have no slot, in the order asked for. */
  missing(blocks: number[]): number[] {
    return blocks.filter((block) => !this.slotOf.has(block));
  }

  /** Claims a slot and fills it with the block's packed values, compact in block order. */
  upload(block: number, values: Float32Array, pinned?: ReadonlySet<number>): void {
    const texels = blockTexels(this.grid, block);
    if (values.length !== texels * 4) throw new Error("the block values do not match its texels");
    const slot = this.claim(block, pinned);

    const patchWidth = Math.min(ANALYSIS_MAX_TEXTURE_SIZE, texels);
    const patchHeight = Math.ceil(texels / patchWidth);
    const floats = patchWidth * patchHeight * 4;
    let data = values;
    if (values.length !== floats) {
      if (!this.staging || this.staging.length < floats) this.staging = new Float32Array(floats);
      data = this.staging.subarray(0, floats);
      data.set(values);
    }
    const patchTex = this.uploadTexture(patchWidth, patchHeight);
    patchTex.image.data = data;
    patchTex.needsUpdate = true;
    this.gl.initTexture(patchTex);

    patchMaterial.uniforms.patchTex.value = patchTex;
    patchMaterial.uniforms.destWidth.value = this.pageWidth;
    patchMaterial.uniforms.destHeight.value = this.pageHeight;
    patchMaterial.uniforms.patchWidth.value = patchWidth;
    this.draw(patchMaterial, this.pageTarget(this.pageOf(slot)), [this.slotStart(slot), texels, 0]);
    patchMaterial.uniforms.patchTex.value = null;
  }

  /**
   * Draws the blocks' slot texels into `target` where `view` places them.
   * Throws when a block has no slot, so a stale slot can never pass for the
   * block's committed state.
   */
  compose(view: CanvasView, blocks: number[], target: WebGLRenderTarget): void {
    const byPage = this.viewTriplesByPage(view, blocks);
    patchMaterial.uniforms.destWidth.value = target.width;
    patchMaterial.uniforms.destHeight.value = target.height;
    patchMaterial.uniforms.patchWidth.value = this.pageWidth;
    for (const [page, triples] of byPage) {
      patchMaterial.uniforms.patchTex.value = this.pageTarget(page).texture;
      this.draw(patchMaterial, target, triples);
    }
    patchMaterial.uniforms.patchTex.value = null;
  }

  /**
   * Folds the blocks' texels from the composed `source` texture back into
   * their slots, claiming slots as needed. The claims never evict one of the
   * given blocks for another, nor one of `keep`.
   */
  copyBack(view: CanvasView, blocks: number[], source: Texture, keep?: Iterable<number>): void {
    const pinned = new Set(blocks);
    if (keep) for (const block of keep) pinned.add(block);
    for (const block of blocks) this.claim(block, pinned);
    const byPage = this.viewTriplesByPage(view, blocks);
    gatherMaterial.uniforms.sourceTex.value = source;
    gatherMaterial.uniforms.sourceWidth.value = view.textureWidth;
    gatherMaterial.uniforms.destWidth.value = this.pageWidth;
    gatherMaterial.uniforms.destHeight.value = this.pageHeight;
    for (const [page, triples] of byPage) {
      this.draw(gatherMaterial, this.pageTarget(page), triples);
    }
    gatherMaterial.uniforms.sourceTex.value = null;
  }

  /** Forgets the given blocks (or every block), freeing their slots. */
  invalidate(blocks?: number[]): void {
    if (!blocks) {
      this.slotOf.clear();
      this.blockOf.fill(-1);
      return;
    }
    for (const block of blocks) {
      const slot = this.slotOf.get(block);
      if (slot === undefined) continue;
      this.slotOf.delete(block);
      this.blockOf[slot] = -1;
    }
  }

  dispose(): void {
    for (const page of this.pages) page?.dispose();
    this.pages.length = 0;
    for (const texture of this.uploads.values()) texture.dispose();
    this.uploads.clear();
    this.staging = null;
    this.invalidate();
  }

  /** The texture blocks of `width` by `height` texels are uploaded through, made on first use. */
  private uploadTexture(width: number, height: number): DataTexture {
    const key = `${width}x${height}`;
    let texture = this.uploads.get(key);
    if (!texture) {
      texture = new DataTexture(new Float32Array(width * height * 4), width, height, RGBAFormat, FloatType);
      texture.minFilter = NearestFilter;
      texture.magFilter = NearestFilter;
      texture.generateMipmaps = false;
      this.uploads.set(key, texture);
    }
    return texture;
  }

  /**
   * Per-band (view texel, count, slot texel) triples for the blocks, grouped
   * by the page their slots live in. The triple order matches both copy
   * materials: patch reads (dest, count, src) and gather (src, count, dest).
   */
  private viewTriplesByPage(view: CanvasView, blocks: number[]): Map<number, number[]> {
    const byPage = new Map<number, number[]>();
    for (const block of blocks) {
      const slot = this.slotOf.get(block);
      if (slot === undefined) throw new Error("the block has no slot");
      this.lastUse[slot] = ++this.tick;
      const list = blockPixelRanges(this.grid, block);
      const fileRanges = list.ranges.subarray(0, list.count * 2);
      const viewRanges = fileRangesToView(view, this.grid.layout, fileRanges);
      if (!viewRanges) throw new Error("the block lies outside the view");
      const page = this.pageOf(slot);
      let triples = byPage.get(page);
      if (!triples) {
        triples = [];
        byPage.set(page, triples);
      }
      let slotAt = this.slotStart(slot);
      for (let i = 0; i + 1 < viewRanges.length; i += 2) {
        triples.push(viewRanges[i], viewRanges[i + 1], slotAt);
        slotAt += viewRanges[i + 1];
      }
    }
    return byPage;
  }

  private claim(block: number, pinned?: ReadonlySet<number>): number {
    const existing = this.slotOf.get(block);
    if (existing !== undefined) {
      this.lastUse[existing] = ++this.tick;
      return existing;
    }
    let slot = -1;
    for (let s = 0; s < this.capacity; s++) {
      if (this.blockOf[s] === -1) {
        slot = s;
        break;
      }
    }
    if (slot === -1) {
      let oldest = Infinity;
      for (let s = 0; s < this.capacity; s++) {
        if (pinned?.has(this.blockOf[s])) continue;
        if (this.lastUse[s] < oldest) {
          oldest = this.lastUse[s];
          slot = s;
        }
      }
      if (slot === -1) throw new Error("every slot is pinned");
      this.slotOf.delete(this.blockOf[slot]);
    }
    this.blockOf[slot] = block;
    this.slotOf.set(block, slot);
    this.lastUse[slot] = ++this.tick;
    return slot;
  }

  private pageOf(slot: number): number {
    return Math.floor(slot / this.pageSlots);
  }

  private slotStart(slot: number): number {
    return (slot % this.pageSlots) * this.slotTexels;
  }

  private pageTarget(page: number): WebGLRenderTarget {
    let target = this.pages[page];
    if (!target) {
      target = new WebGLRenderTarget(this.pageWidth, this.pageHeight, {
        format: RGBAFormat,
        type: FloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this.pages[page] = target;
    }
    return target;
  }

  private draw(material: RawShaderMaterial, target: WebGLRenderTarget, triples: number[]): void {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(QUAD_POSITIONS, 3));
    geometry.setIndex(new BufferAttribute(QUAD_INDICES, 1));
    geometry.setAttribute("aRange", new InstancedBufferAttribute(Uint32Array.from(triples), 3));
    geometry.instanceCount = triples.length / 3;
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.add(mesh);
    const prevAutoClear = this.gl.autoClear;
    this.gl.autoClear = false;
    this.gl.setRenderTarget(target);
    this.gl.render(scene, this.camera);
    this.gl.setRenderTarget(null);
    this.gl.autoClear = prevAutoClear;
    geometry.dispose();
  }
}
