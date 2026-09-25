import {
  BufferAttribute,
  DataTexture,
  FloatType,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RawShaderMaterial,
  RedFormat,
  RGBAFormat,
  Scene,
  Texture,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { gatherMaterial } from "../components/gather-material";
import { patchMaterial } from "../components/patch-material";
import { readRenderTargetPixelsAsync } from "./async-readpixels";
import { bandAtPixel } from "./band-layout";
import { blockBandLayout, blockPixelRanges, blockTexels, PACKED_BYTES_PER_TEXEL, type BlockGrid } from "./block-grid";
import { fileRangesToView, type CanvasView } from "./canvas-view";
import { ANALYSIS_MAX_TEXTURE_SIZE } from "./constants";

const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

const DEFAULT_PAGE_BYTES = 128 * 1024 * 1024;

/** How a slot page stores a texel. */
export type SlotTexel = {
  bytes: number;
  format: typeof RGBAFormat | typeof RedFormat;
  type: typeof FloatType | typeof HalfFloatType;
};

/** A packed coefficient texel: magnitude and phase for both channels, as float32. */
export const PACKED_SLOT_TEXEL: SlotTexel = { bytes: PACKED_BYTES_PER_TEXEL, format: RGBAFormat, type: FloatType };

/** A stroke mask texel: one half-float weight. */
export const MASK_SLOT_TEXEL: SlotTexel = { bytes: 2, format: RedFormat, type: HalfFloatType };

/**
 * GPU home of a file's committed block texels. Each block lives in a
 * fixed-size slot inside a page texture; slots are claimed under a byte
 * budget and the least recently used block leaves when every slot is taken.
 * Blocks move from their slots into a view's packed layout by GPU range
 * copies, so composing a view costs the block's texels, not the file's.
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

  private readonly texel: SlotTexel;

  constructor(
    gl: WebGLRenderer,
    grid: BlockGrid,
    maxBytes: number,
    pageBytes = DEFAULT_PAGE_BYTES,
    texel: SlotTexel = PACKED_SLOT_TEXEL,
  ) {
    this.gl = gl;
    this.grid = grid;
    this.texel = texel;
    this.slotTexels = blockTexels(grid, 0);
    const slotBytes = this.slotTexels * texel.bytes;
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
    return pages * this.pageWidth * this.pageHeight * this.texel.bytes;
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
   * Draws the named file pixels from their slots into `target`, where `view`
   * places them. Throws when a pixel's block has no slot.
   */
  composeRanges(view: CanvasView, fileRanges: Uint32Array, target: WebGLRenderTarget): void {
    const { byPage } = this.rangeTriplesByPage(fileRanges, true, view);
    patchMaterial.uniforms.destWidth.value = target.width;
    patchMaterial.uniforms.destHeight.value = target.height;
    patchMaterial.uniforms.patchWidth.value = this.pageWidth;
    for (const [page, triples] of byPage) {
      // (slot, count, view) as the patch material's (src, count, dest) wants them.
      for (let i = 0; i < triples.length; i += 3) {
        const slotTexel = triples[i];
        triples[i] = triples[i + 2];
        triples[i + 2] = slotTexel;
      }
      patchMaterial.uniforms.patchTex.value = this.pageTarget(page).texture;
      this.draw(patchMaterial, target, triples);
    }
    patchMaterial.uniforms.patchTex.value = null;
  }

  /**
   * Copies the blocks' texels out of `source`, laid out as `view` lays them,
   * into slots of their own. With `pinned`, a block outside it and outside
   * `blocks` may be pushed out to make room; without, the cache must have a
   * free slot for every block that has none.
   */
  take(view: CanvasView, blocks: number[], source: Texture, pinned?: Iterable<number>): void {
    const keep = this.pinning(blocks, pinned);
    for (const block of blocks) this.claim(block, keep);
    const byPage = this.viewTriplesByPage(view, blocks);
    gatherMaterial.uniforms.sourceTex.value = source;
    gatherMaterial.uniforms.sourceWidth.value = view.textureWidth;
    gatherMaterial.uniforms.destWidth.value = this.pageWidth;
    gatherMaterial.uniforms.destHeight.value = this.pageHeight;
    for (const [page, triples] of byPage) this.draw(gatherMaterial, this.pageTarget(page), triples);
    gatherMaterial.uniforms.sourceTex.value = null;
  }

  /**
   * Copies the blocks from the slots of `from`, a cache on the same grid,
   * into slots of this one; a block outside `pinned` and `blocks` may be
   * pushed out to make room.
   */
  copyFrom(from: BlockSlotCache, blocks: number[], pinned: Iterable<number>): void {
    const keep = this.pinning(blocks, pinned);
    const byPages = new Map<string, { source: number; dest: number; triples: number[] }>();
    for (const block of blocks) {
      const source = from.slotOf.get(block);
      if (source === undefined) throw new Error("the block has no slot to copy from");
      const dest = this.claim(block, keep);
      const key = `${from.pageOf(source)}:${this.pageOf(dest)}`;
      let entry = byPages.get(key);
      if (!entry) {
        entry = { source: from.pageOf(source), dest: this.pageOf(dest), triples: [] };
        byPages.set(key, entry);
      }
      entry.triples.push(this.slotStart(dest), blockTexels(this.grid, block), from.slotStart(source));
    }
    patchMaterial.uniforms.destWidth.value = this.pageWidth;
    patchMaterial.uniforms.destHeight.value = this.pageHeight;
    patchMaterial.uniforms.patchWidth.value = from.pageWidth;
    for (const { source, dest, triples } of byPages.values()) {
      patchMaterial.uniforms.patchTex.value = from.pageTarget(source).texture;
      this.draw(patchMaterial, this.pageTarget(dest), triples);
    }
    patchMaterial.uniforms.patchTex.value = null;
  }

  /**
   * Writes `values`, compact in the order of the file pixel ranges, into the
   * slots of the blocks they fall in. Blocks with no slot are left alone.
   */
  patch(fileRanges: Uint32Array, values: Float32Array): void {
    const { byPage, texels } = this.rangeTriplesByPage(fileRanges, false);
    if (byPage.size === 0) return;
    if (values.length !== texels * 4) throw new Error("the patch values do not match the ranges");
    const patchWidth = Math.min(ANALYSIS_MAX_TEXTURE_SIZE, texels);
    const patchHeight = Math.ceil(texels / patchWidth);
    let data = values;
    if (values.length !== patchWidth * patchHeight * 4) {
      data = new Float32Array(patchWidth * patchHeight * 4);
      data.set(values);
    }
    const patchTex = new DataTexture(data, patchWidth, patchHeight, RGBAFormat, FloatType);
    patchTex.minFilter = NearestFilter;
    patchTex.magFilter = NearestFilter;
    patchTex.generateMipmaps = false;
    patchTex.needsUpdate = true;
    this.gl.initTexture(patchTex);
    patchMaterial.uniforms.patchTex.value = patchTex;
    patchMaterial.uniforms.destWidth.value = this.pageWidth;
    patchMaterial.uniforms.destHeight.value = this.pageHeight;
    patchMaterial.uniforms.patchWidth.value = patchWidth;
    for (const [page, triples] of byPage) this.draw(patchMaterial, this.pageTarget(page), triples);
    patchMaterial.uniforms.patchTex.value = null;
    patchTex.dispose();
  }

  /**
   * Reads the named file pixels out of the slots that hold them, four floats
   * a pixel in range order; a one-channel cache fills the first of each four.
   * The copy is issued at the call, so the slots may change once it returns.
   * Throws when a pixel's block has no slot.
   */
  read(fileRanges: Uint32Array): Promise<Float32Array> {
    const { byPage, texels } = this.rangeTriplesByPage(fileRanges, true);
    if (texels === 0) return Promise.resolve(new Float32Array(0));
    const width = Math.min(ANALYSIS_MAX_TEXTURE_SIZE, texels);
    const height = Math.ceil(texels / width);
    const target = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    gatherMaterial.uniforms.sourceWidth.value = this.pageWidth;
    gatherMaterial.uniforms.destWidth.value = width;
    gatherMaterial.uniforms.destHeight.value = height;
    for (const [page, triples] of byPage) {
      gatherMaterial.uniforms.sourceTex.value = this.pageTarget(page).texture;
      this.draw(gatherMaterial, target, triples);
    }
    gatherMaterial.uniforms.sourceTex.value = null;
    return readRenderTargetPixelsAsync(this.gl, target, 0, 0, width, height)
      .then((padded) => (padded.length === texels * 4 ? padded : padded.slice(0, texels * 4)))
      .finally(() => target.dispose());
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
   * by the page their slots live in, in the order the patch material reads.
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

  /**
   * (slot texel, count, compact texel) triples for the named file pixels,
   * grouped by the page their slots live in: the order the patch material
   * reads as (dest, count, src) and the gather material as (src, count,
   * dest). With `requireSlot` a pixel whose block has no slot throws;
   * otherwise it is skipped. With `view`, the third of each triple is the
   * texel `view` places the pixel at rather than its compact place.
   */
  private rangeTriplesByPage(
    fileRanges: Uint32Array,
    requireSlot: boolean,
    view?: CanvasView,
  ): { byPage: Map<number, number[]>; texels: number } {
    const { layout } = this.grid;
    const byPage = new Map<number, number[]>();
    const layouts = new Map<number, Uint32Array>();
    let srcAt = 0;
    for (let i = 0; i + 1 < fileRanges.length; i += 2) {
      const start = fileRanges[i];
      const end = start + fileRanges[i + 1];
      let pixel = start;
      for (let band = bandAtPixel(layout, start); pixel < end && band < layout.numBands; band++) {
        const offset = layout.metadata[band * 4];
        const bandEnd = offset + layout.metadata[band * 4 + 1];
        const bins = this.grid.binsPerBlock[band];
        while (pixel < Math.min(end, bandEnd)) {
          const block = Math.floor((pixel - offset) / bins);
          const blockEnd = Math.min(end, bandEnd, offset + (block + 1) * bins);
          const slot = this.slotOf.get(block);
          if (slot === undefined && requireSlot) throw new Error("the block has no slot");
          if (slot !== undefined) {
            let bandOffsets = layouts.get(block);
            if (!bandOffsets) {
              bandOffsets = blockBandLayout(this.grid, block).bandOffsets;
              layouts.set(block, bandOffsets);
            }
            const inBlock = bandOffsets[band] + (pixel - offset - block * bins);
            const page = this.pageOf(slot);
            let triples = byPage.get(page);
            if (!triples) {
              triples = [];
              byPage.set(page, triples);
            }
            const other = view
              ? view.layout.metadata[band * 4] + (pixel - view.ranges[band * 2])
              : srcAt + (pixel - start);
            triples.push(this.slotStart(slot) + inBlock, blockEnd - pixel, other);
          }
          pixel = blockEnd;
        }
      }
      srcAt += fileRanges[i + 1];
    }
    return { byPage, texels: srcAt };
  }

  /**
   * The blocks a claim for `blocks` may not push out: `blocks` and `pinned`
   * together, or, with no `pinned`, every block held, so the claim needs a
   * free slot.
   */
  private pinning(blocks: number[], pinned?: Iterable<number>): ReadonlySet<number> {
    if (!pinned) {
      if (this.missing(blocks).length > this.freeSlots) throw new Error("the cache has no room for the blocks");
      return new Set(blocks);
    }
    const keep = new Set(blocks);
    for (const block of pinned) keep.add(block);
    return keep;
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
        format: this.texel.format,
        type: this.texel.type,
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
