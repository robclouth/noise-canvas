import {
  DataTexture,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import levelCanvasFrag from "../glsl/level-canvas.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { packedFold } from "./constants";
import type { CanvasView } from "./canvas-view";
import { displayLevelChoice, sourceBinRanges, type DisplayPyramidLevel } from "./display-pyramid";
import type { StrokeRenderer } from "./stroke-renderer";

/** Texels a coarse canvas may hold: its scratch costs as much per texel as the canvas's own. */
export const COARSE_CANVAS_MAX_TEXELS = 1_000_000;

/** A view over the whole file laid out as one display pyramid level, each band at the level's step. */
export function levelCanvasView(level: DisplayPyramidLevel, numFrames: number): CanvasView {
  const numBands = level.metadata.length / 4;
  const metadata = Float64Array.from(level.metadata);
  const ranges = new Uint32Array(numBands * 2);
  let texels = 0;
  for (let band = 0; band < numBands; band++) {
    ranges[band * 2] = metadata[band * 4];
    ranges[band * 2 + 1] = metadata[band * 4 + 1];
    texels += metadata[band * 4 + 1];
  }
  const { width, height } = packedFold(texels);
  return {
    firstBlock: 0,
    lastBlock: 0,
    startFrame: 0,
    endFrame: numFrames,
    ranges,
    layout: { numBands, metadata },
    bandK0: new Uint32Array(numBands),
    texels,
    textureWidth: width,
    textureHeight: height,
  };
}

/**
 * The level a coarse canvas takes for a screen showing `framesPerPixel`
 * frames in each pixel: the one the display draws, or the finest coarser one
 * whose canvas holds no more than `maxTexels`.
 */
export function coarseLevelIndex(
  levels: DisplayPyramidLevel[],
  framesPerPixel: number,
  readyFrom: number,
  maxTexels = COARSE_CANVAS_MAX_TEXELS,
): number {
  let index = displayLevelChoice(levels, framesPerPixel, readyFrom).fine;
  while (index < levels.length - 1 && levelTexels(levels[index]) > maxTexels) index++;
  return index;
}

function levelTexels(level: DisplayPyramidLevel): number {
  let texels = 0;
  for (let band = 0; band < level.metadata.length / 4; band++) texels += level.metadata[band * 4 + 1];
  return texels;
}

const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);

/**
 * The file at the resolution the screen shows it, on a renderer beside the
 * canvas: a dab the canvas cannot show whole is previewed here, and the dabs
 * of a stroke on a windowed file are painted here too, so the picture shows
 * them before their full-resolution paint lands. It is drawn from the display
 * pyramid, as magnitudes with zero phase.
 */
export class CoarseCanvas {
  private renderer: StrokeRenderer | null = null;
  private currentView: CanvasView | null = null;
  private levelIndex = -1;
  private revision = -1;
  private stroking = false;
  private framesPerPixel = Infinity;
  private previewShown = false;
  private strokeRanges: DataTexture | null = null;
  private readonly material = new RawShaderMaterial({
    uniforms: { levelTex: { value: null }, targetWidth: { value: 1 } },
    vertexShader: passThroughVert,
    fragmentShader: levelCanvasFrag,
    glslVersion: GLSL3,
  });
  private readonly scene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), this.material));

  constructor(private readonly gl: WebGLRenderer) {}

  /** The renderer and view to paint on, or null until `sync` has placed them. */
  get target(): { renderer: StrokeRenderer; view: CanvasView } | null {
    return this.renderer && this.currentView ? { renderer: this.renderer, view: this.currentView } : null;
  }

  /** Records how many frames a pixel of the screen showing the file holds, which picks the level. */
  aimAt(framesPerPixel: number): void {
    this.framesPerPixel = framesPerPixel;
  }

  /**
   * Brings the canvas to the pyramid level of `parent` the screen draws,
   * redrawn from the pyramid when the level or the picture moved. A stroke
   * keeps the canvas as it is until it ends. False when the pyramid holds no
   * picture yet.
   */
  sync(parent: StrokeRenderer, numFrames: number): boolean {
    const pyramid = parent.getDisplayPyramid();
    if (!pyramid || !pyramid.texture(0)) return false;
    if (this.stroking) return this.renderer !== null;
    const levelIndex = coarseLevelIndex(pyramid.levels, this.framesPerPixel, pyramid.readyLevel);
    const level = pyramid.texture(levelIndex);
    if (!level) return false;
    if (levelIndex !== this.levelIndex || !this.renderer) {
      this.renderer?.dispose();
      this.currentView = levelCanvasView(pyramid.levels[levelIndex], numFrames);
      this.renderer = parent.beside(this.currentView);
      this.levelIndex = levelIndex;
      this.revision = -1;
    }
    if (this.revision !== pyramid.revision) {
      const fill = (target: WebGLRenderTarget): void => {
        this.material.uniforms.levelTex.value = level;
        this.material.uniforms.targetWidth.value = target.width;
        const previous = this.gl.getRenderTarget();
        this.gl.setRenderTarget(target);
        this.gl.render(this.scene, camera);
        this.gl.setRenderTarget(previous);
        this.material.uniforms.levelTex.value = null;
      };
      if (this.renderer.getIsInitialized()) this.renderer.fillCanvas(fill);
      else this.renderer.initialize(fill);
      this.revision = pyramid.revision;
    }
    return true;
  }

  /** Starts holding the dabs of a stroke, which stay on the canvas until `endStroke`. */
  beginStroke(): void {
    if (!this.renderer) return;
    this.stroking = true;
    this.renderer.beginStroke();
  }

  /** Lets the canvas follow the pyramid again, which by now holds the stroke. */
  endStroke(): void {
    if (!this.stroking) return;
    this.stroking = false;
    this.renderer?.endStroke();
    this.revision = -1;
  }

  /** Records whether this frame shows a dab previewed on the canvas. */
  showPreview(shown: boolean): void {
    this.previewShown = shown;
  }

  /** The canvas's picture and its preview for the display, while a preview is shown; null otherwise. */
  previewDisplay(): { committed: Texture; preview: Texture; binRanges: Texture } | null {
    if (!this.previewShown || !this.renderer) return null;
    const { committed, preview, binRanges, active } = this.renderer.getPreviewDisplay();
    return active ? { committed, preview, binRanges } : null;
  }

  /** The per-band layout of the canvas, for the display's metadata sampler. */
  get metadata(): Texture | null {
    return this.renderer?.getTextures().metadata ?? null;
  }

  /** True while a stroke's dabs are on the canvas. */
  get holdsStroke(): boolean {
    return this.stroking;
  }

  /**
   * The canvas's picture and the per-band bin ranges [start, end) the stroke
   * painted in its layout, for the display; null while no stroke has painted.
   */
  strokeDisplay(): { committed: Texture; binRanges: DataTexture } | null {
    const renderer = this.renderer;
    const view = this.currentView;
    if (!this.stroking || !renderer || !view) return null;
    const ranges = renderer.getDirtyPixelRanges();
    if (!ranges) return null;
    const bins = sourceBinRanges(view.layout, ranges);
    if (!this.strokeRanges || this.strokeRanges.image.width !== view.layout.numBands) {
      this.strokeRanges?.dispose();
      this.strokeRanges = new DataTexture(
        new Float32Array(view.layout.numBands * 4),
        view.layout.numBands,
        1,
        RGBAFormat,
        FloatType,
      );
      this.strokeRanges.minFilter = NearestFilter;
      this.strokeRanges.magFilter = NearestFilter;
    }
    const data = this.strokeRanges.image.data as Float32Array;
    data.fill(0);
    for (let band = 0; band < view.layout.numBands; band++) {
      data[band * 4] = bins[band * 2];
      data[band * 4 + 1] = bins[band * 2 + 1];
    }
    this.strokeRanges.needsUpdate = true;
    return { committed: renderer.getPreviewDisplay().committed, binRanges: this.strokeRanges };
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.currentView = null;
    this.strokeRanges?.dispose();
    this.material.dispose();
    for (const child of this.scene.children) if (child instanceof Mesh) child.geometry.dispose();
  }
}
