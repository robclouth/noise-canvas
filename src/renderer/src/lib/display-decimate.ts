import {
  BufferAttribute,
  DynamicDrawUsage,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  Texture,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";

import displayMagsGlsl from "../glsl/display-mags.glsl";
import type { CanvasView } from "./canvas-view";

const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

/**
 * Where a decimate draw reads its pairs from: another display texture's dB,
 * the canvas's RGBA magnitude/phase, or a CPU upload's magnitude pair.
 */
export type SourcePixels = "levelDb" | "canvas" | "chunk";

/** One instance of the decimate draw: destination bins, their first source bin, and the source stride. */
export type DecimateInstance = { destStart: number; destCount: number; srcStart: number; decimation: number };

/** A texture holding committed packed texels over `view`'s span, laid out by the view. */
export type CommittedSource = { texture: Texture; view: CanvasView };

/**
 * Clamps a run of decimated bins to the ones whose source tap
 * `bin * decimation` lies inside the source bins [firstBin, endBin).
 */
export function clampToSourceBins(
  start: number,
  end: number,
  decimation: number,
  firstBin: number,
  endBin: number,
): { start: number; end: number } {
  return {
    start: Math.max(start, Math.ceil(firstBin / decimation)),
    end: Math.min(end, Math.ceil(endBin / decimation)),
  };
}

/**
 * Reads one destination bin per fragment from its source bin, `decimation`
 * bins apart. `sourceIsLinear` picks the magnitude pair a CPU upload carries
 * over the dB pair a display texture already holds.
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
 * The instanced draw that fills ranges of a display texture by striding
 * through a source. Shared by every display texture that is cut from the
 * packed layout.
 */
export class DecimateDraw {
  private readonly material = createDecimateMaterial();
  private readonly scene = new Scene();
  private readonly geometry = new InstancedBufferGeometry();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private attribute: InstancedBufferAttribute;

  constructor() {
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

  /** Grows the instance buffer now, so a later `run` allocates nothing. */
  reserve(capacity: number): void {
    if (capacity * 4 > this.attribute.array.length) this.attribute = this.createAttribute(capacity);
  }

  /** Draws every instance into `target`, leaving texels no instance covers alone. */
  run(
    gl: WebGLRenderer,
    target: WebGLRenderTarget,
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
    this.material.dispose();
    this.geometry.dispose();
  }
}
