import {
  BufferAttribute,
  ClampToEdgeWrapping,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  GLSL3,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RawShaderMaterial,
  RGBAFormat,
  RGFormat,
  Scene,
  Texture,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";

import displayMagsGlsl from "../glsl/display-mags.glsl";
import {
  displayPyramidLevels,
  levelBinSpan,
  levelDecimation,
  sourceBinRanges,
  type BandLayout,
  type DisplayPyramidLevel,
} from "./display-pyramid";
import type { PixelRangeList } from "./range-quads";

const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

// Bins one CPU upload batch may hold: 8192 wide by 512 rows is 32 MB of RG32F,
// small enough to stay transient and large enough that a whole file seeds in a
// handful of draws.
const UPLOAD_CHUNK_BINS = 8192 * 512;
const UPLOAD_CHUNK_WIDTH = 8192;

/**
 * Reads one destination bin per fragment from its source bin, `decimation`
 * bins apart. `sourceIsLinear` picks the magnitude pair a CPU upload carries
 * over the dB pair a finer level already holds.
 */
function createDecimateMaterial(): RawShaderMaterial {
  return new RawShaderMaterial({
    uniforms: {
      inputTex: { value: null },
      destWidth: { value: 0 },
      destHeight: { value: 0 },
      srcWidth: { value: 0 },
      sourceIsLinear: { value: false },
      sourceRightInBlue: { value: false },
    },
    vertexShader: /*glsl*/ `
      precision highp float;
      precision highp int;

      in vec3 position;
      in uvec4 aRange;

      uniform int destWidth;
      uniform int destHeight;

      flat out uvec4 vRange;

      void main() {
        uint w = uint(destWidth);
        uint destStart = aRange.x;
        uint destEnd = destStart + aRange.y;
        vRange = aRange;

        uint row0 = destStart / w;
        uint row1 = (destEnd - 1u) / w;
        // A range confined to one row spans only its own columns; one crossing
        // a row boundary is bounded by the full width.
        float x0 = row0 == row1 ? float(destStart - row0 * w) : 0.0;
        float x1 = row0 == row1 ? float(destEnd - row0 * w) : float(w);

        gl_Position = vec4(
          2.0 * mix(x0, x1, position.x) / float(destWidth) - 1.0,
          2.0 * mix(float(row0), float(row1 + 1u), position.y) / float(destHeight) - 1.0,
          0.0,
          1.0
        );
      }
    `,
    fragmentShader: /*glsl*/ `
      precision highp float;
      precision highp sampler2D;
      precision highp int;

      flat in uvec4 vRange;

      uniform sampler2D inputTex;
      uniform int destWidth;
      uniform int srcWidth;
      uniform bool sourceIsLinear;
      uniform bool sourceRightInBlue;

      out vec4 outColor;

      ${displayMagsGlsl}

      void main() {
        uint destPixel = uint(gl_FragCoord.y) * uint(destWidth) + uint(gl_FragCoord.x);
        // The bounding box overhangs the range at both ends when it wraps rows.
        if (destPixel < vRange.x || destPixel >= vRange.x + vRange.y) discard;

        uint srcPixel = vRange.z + (destPixel - vRange.x) * vRange.w;
        vec4 texel = texelFetch(inputTex, ivec2(int(srcPixel % uint(srcWidth)), int(srcPixel / uint(srcWidth))), 0);
        vec2 pair = sourceRightInBlue ? texel.rb : texel.rg;
        outColor = sourceIsLinear
          ? vec4(displayMagToDb(pair.r), displayMagToDb(pair.g), 0.0, 0.0)
          : vec4(pair, 0.0, 0.0);
      }
    `,
    glslVersion: GLSL3,
    depthTest: false,
    depthWrite: false,
  });
}

/**
 * Where a decimate draw reads its pairs from: another level's dB, the canvas's
 * RGBA magnitude/phase, or a CPU upload's magnitude pair.
 */
type SourcePixels = "levelDb" | "canvas" | "chunk";

/** One instance of the decimate draw: destination bins, their first source bin, and the source stride. */
type DecimateInstance = { destStart: number; destCount: number; srcStart: number; decimation: number };

/**
 * The display's committed picture, as a stack of dB magnitude levels over the
 * packed band layout. The stack's size is capped, so a longer file starts at a
 * coarser level rather than holding more.
 */
export class DisplayPyramid {
  readonly levels: DisplayPyramidLevel[];
  private readonly targets: WebGLRenderTarget[];
  private readonly metadataTextures: DataTexture[];
  private readonly material = createDecimateMaterial();
  private readonly scene = new Scene();
  private readonly geometry = new InstancedBufferGeometry();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private attribute: InstancedBufferAttribute;
  private readonly layout: BandLayout;
  private readonly uploadChunkBins: number;
  private seeded = false;

  constructor(layout: BandLayout, opts?: { maxTexels?: number; uploadChunkBins?: number }) {
    this.layout = layout;
    this.uploadChunkBins = opts?.uploadChunkBins ?? UPLOAD_CHUNK_BINS;
    this.levels = displayPyramidLevels(layout, opts?.maxTexels);

    this.targets = this.levels.map(
      (level) =>
        new WebGLRenderTarget(level.textureWidth, level.textureHeight, {
          format: RGFormat,
          type: HalfFloatType,
          minFilter: NearestFilter,
          magFilter: NearestFilter,
          depthBuffer: false,
          stencilBuffer: false,
        }),
    );
    this.metadataTextures = this.levels.map((level) => {
      const texture = new DataTexture(level.metadata, layout.numBands, 1, RGBAFormat, FloatType);
      texture.internalFormat = "RGBA32F";
      texture.minFilter = NearestFilter;
      texture.magFilter = NearestFilter;
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.needsUpdate = true;
      return texture;
    });

    this.geometry.setAttribute("position", new BufferAttribute(QUAD_POSITIONS, 3));
    this.geometry.setIndex(new BufferAttribute(QUAD_INDICES, 1));
    this.attribute = this.createAttribute(64);
    const mesh = new Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.camera.position.z = 1;
  }

  private createAttribute(capacity: number): InstancedBufferAttribute {
    const attribute = new InstancedBufferAttribute(new Uint32Array(capacity * 4), 4);
    attribute.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("aRange", attribute);
    return attribute;
  }

  /** The dB magnitudes of one level; null until the pyramid is seeded. */
  texture(levelIndex: number): Texture | null {
    return this.seeded ? this.targets[levelIndex].texture : null;
  }

  /** The per-band layout of one level, for the display's metadata sampler. */
  metadataTexture(levelIndex: number): DataTexture {
    return this.metadataTextures[levelIndex];
  }

  /** Texels every level holds together. */
  texelCount(): number {
    return this.levels.reduce((sum, level) => sum + level.texelCount, 0);
  }

  /**
   * Encodes the whole packed state, then decimates it up the stack. Texels
   * past the last band are left alone: no band's metadata reaches them, so
   * nothing samples them.
   */
  seedFromPacked(gl: WebGLRenderer, data: Float32Array): void {
    const instances: DecimateInstance[] = [];
    for (let band = 0; band < this.layout.numBands; band++) {
      const instance = this.finestInstance(band, 0, this.layout.metadata[band * 4 + 1]);
      if (instance) instances.push(instance);
    }
    this.uploadInstances(gl, data, instances);
    this.seeded = true;
    this.decimateUpward(gl, null);
  }

  /**
   * Re-encodes the bins `pixelRanges` covers and decimates them up the stack.
   * A patch into an unseeded pyramid is skipped: the seed that must follow
   * reads the same packed state.
   */
  patchFromPacked(gl: WebGLRenderer, data: Float32Array, pixelRanges: Uint32Array): void {
    if (!this.seeded) return;
    const spans = sourceBinRanges(this.layout, pixelRanges);
    const instances: DecimateInstance[] = [];
    for (let band = 0; band < this.layout.numBands; band++) {
      if (spans[band * 2 + 1] <= spans[band * 2]) continue;
      const instance = this.finestInstance(band, spans[band * 2], spans[band * 2 + 1]);
      if (instance) instances.push(instance);
    }
    if (instances.length === 0) return;
    this.uploadInstances(gl, data, instances);
    this.decimateUpward(gl, spans);
  }

  /**
   * Re-encodes the bins `changed` covers straight off the canvas, which holds
   * the packed layout, and carries them up the stack.
   */
  refreshFromCanvas(gl: WebGLRenderer, canvas: Texture, canvasWidth: number, changed: PixelRangeList): void {
    const spans = sourceBinRanges(this.layout, changed.ranges.subarray(0, changed.count * 2));
    const instances: DecimateInstance[] = [];
    for (let band = 0; band < this.layout.numBands; band++) {
      if (spans[band * 2 + 1] <= spans[band * 2]) continue;
      const instance = this.finestInstance(band, spans[band * 2], spans[band * 2 + 1]);
      if (instance) instances.push(instance);
    }
    if (instances.length === 0) return;
    this.draw(gl, 0, canvas, canvasWidth, "canvas", instances);
    this.seeded = true;
    this.decimateUpward(gl, spans);
  }

  /** The instance writing one band's source bins [start, end) into the finest level. */
  private finestInstance(band: number, start: number, end: number): DecimateInstance | null {
    const level = this.levels[0];
    const sourceStep = this.layout.metadata[band * 4 + 2];
    const span = levelBinSpan(level, band, sourceStep, start, end);
    if (span.end <= span.start) return null;
    const decimation = levelDecimation(level, sourceStep, band);
    return {
      destStart: level.metadata[band * 4] + span.start,
      destCount: span.end - span.start,
      srcStart: this.layout.metadata[band * 4] + span.start * decimation,
      decimation,
    };
  }

  /**
   * Rebuilds every level above the finest from the one below it, over the
   * bands `spans` names in source bins, or over all of them when it is null.
   */
  private decimateUpward(gl: WebGLRenderer, spans: Uint32Array | null): void {
    for (let index = 1; index < this.levels.length; index++) {
      const source = this.levels[index - 1];
      const dest = this.levels[index];
      const instances: DecimateInstance[] = [];
      for (let band = 0; band < this.layout.numBands; band++) {
        const sourceStep = this.layout.metadata[band * 4 + 2];
        const start = spans ? spans[band * 2] : 0;
        const end = spans ? spans[band * 2 + 1] : this.layout.metadata[band * 4 + 1];
        if (end <= start) continue;
        const span = levelBinSpan(dest, band, sourceStep, start, end);
        if (span.end <= span.start) continue;
        const decimation = 2 ** (dest.metadata[band * 4 + 2] - source.metadata[band * 4 + 2]);
        instances.push({
          destStart: dest.metadata[band * 4] + span.start,
          destCount: span.end - span.start,
          srcStart: source.metadata[band * 4] + span.start * decimation,
          decimation,
        });
      }
      this.draw(gl, index, this.targets[index - 1].texture, source.textureWidth, "levelDb", instances);
    }
  }

  /**
   * Gathers the bins each instance reads out of the packed array, at the
   * instance's stride, and draws them into the finest level in batches no
   * larger than one upload chunk.
   */
  private uploadInstances(gl: WebGLRenderer, data: Float32Array, instances: DecimateInstance[]): void {
    let index = 0;
    let done = 0;
    while (index < instances.length) {
      const batch: DecimateInstance[] = [];
      const pieces: Array<{ srcStart: number; stride: number; count: number }> = [];
      let used = 0;
      while (index < instances.length && used < this.uploadChunkBins) {
        const instance = instances[index];
        const take = Math.min(instance.destCount - done, this.uploadChunkBins - used);
        pieces.push({
          srcStart: instance.srcStart + done * instance.decimation,
          stride: instance.decimation,
          count: take,
        });
        batch.push({ destStart: instance.destStart + done, destCount: take, srcStart: used, decimation: 1 });
        used += take;
        done += take;
        if (done === instance.destCount) {
          index++;
          done = 0;
        }
      }
      if (used === 0) break;

      const width = Math.min(used, UPLOAD_CHUNK_WIDTH);
      const height = Math.ceil(used / width);
      const chunk = new Float32Array(width * height * 2);
      let at = 0;
      for (const piece of pieces) {
        for (let k = 0; k < piece.count; k++) {
          const source = (piece.srcStart + k * piece.stride) * 4;
          chunk[at * 2] = data[source];
          chunk[at * 2 + 1] = data[source + 2];
          at++;
        }
      }

      const texture = new DataTexture(chunk, width, height, RGFormat, FloatType);
      texture.internalFormat = "RG32F";
      texture.minFilter = NearestFilter;
      texture.magFilter = NearestFilter;
      texture.needsUpdate = true;
      this.draw(gl, 0, texture, width, "chunk", batch);
      texture.dispose();
    }
  }

  private draw(
    gl: WebGLRenderer,
    levelIndex: number,
    source: Texture,
    srcWidth: number,
    mode: SourcePixels,
    instances: DecimateInstance[],
  ): void {
    if (instances.length === 0) return;
    const capacity = this.attribute.array.length / 4;
    if (instances.length > capacity) {
      this.attribute = this.createAttribute(Math.max(instances.length, capacity * 2));
    }
    const array = this.attribute.array as Uint32Array;
    for (let i = 0; i < instances.length; i++) {
      array[i * 4] = instances[i].destStart;
      array[i * 4 + 1] = instances[i].destCount;
      array[i * 4 + 2] = instances[i].srcStart;
      array[i * 4 + 3] = instances[i].decimation;
    }
    this.attribute.clearUpdateRanges();
    this.attribute.addUpdateRange(0, instances.length * 4);
    this.attribute.needsUpdate = true;
    this.geometry.instanceCount = instances.length;

    const target = this.targets[levelIndex];
    this.material.uniforms.inputTex.value = source;
    this.material.uniforms.destWidth.value = target.width;
    this.material.uniforms.destHeight.value = target.height;
    this.material.uniforms.srcWidth.value = srcWidth;
    this.material.uniforms.sourceIsLinear.value = mode !== "levelDb";
    this.material.uniforms.sourceRightInBlue.value = mode === "canvas";

    const previousAutoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(target);
    gl.render(this.scene, this.camera);
    gl.setRenderTarget(null);
    gl.autoClear = previousAutoClear;
    this.material.uniforms.inputTex.value = null;
  }

  dispose(): void {
    for (const target of this.targets) target.dispose();
    for (const texture of this.metadataTextures) texture.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}
