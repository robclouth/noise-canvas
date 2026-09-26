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
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import ncaLoadFrag from "../../glsl/nca-load.frag";
import ncaStepFrag from "../../glsl/nca-step.frag";
import passThroughVert from "../../glsl/pass-through.vert";
import { NCA_CHANNELS, NCA_GRID, NcaWeights, packWeightsForTexture } from "./nca-model";

const TARGETS = NCA_CHANNELS / 4;

function createStateTarget(): WebGLRenderTarget {
  return new WebGLRenderTarget(NCA_GRID, NCA_GRID, {
    count: TARGETS,
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
  });
}

function floatTexture(data: Float32Array, width: number, height: number): DataTexture {
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The automaton's grid on the GPU: two state targets it steps between, and the
 * weights as a float texture. Any material written for the grid (one output
 * per state target) can fill the state with `render`.
 */
export class NcaGpu {
  private targets = [createStateTarget(), createStateTarget()];
  private currentIndex = 0;
  private stepMaterial: RawShaderMaterial;
  private scene = new Scene();
  private mesh: Mesh;
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private weightsTexture: DataTexture | null = null;
  private weightsSource: NcaWeights | null = null;
  private steps = 0;

  constructor() {
    this.stepMaterial = new RawShaderMaterial({
      uniforms: {
        ncaState0: { value: null },
        ncaState1: { value: null },
        ncaState2: { value: null },
        ncaWeights: { value: null },
        ncaGrid: { value: NCA_GRID },
        ncaFireAll: { value: false },
        ncaStepSeed: { value: 0 },
      },
      vertexShader: passThroughVert,
      fragmentShader: ncaStepFrag,
      glslVersion: GLSL3,
    });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.stepMaterial);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** The target holding the latest state. */
  get current(): WebGLRenderTarget {
    return this.targets[this.currentIndex];
  }

  setWeights(weights: NcaWeights): void {
    if (weights === this.weightsSource) return;
    const { data, width, height } = packWeightsForTexture(weights);
    this.weightsTexture?.dispose();
    this.weightsTexture = floatTexture(data, width, height);
    this.weightsSource = weights;
  }

  /** Draws `material` over the whole grid into the state that is not current, then makes it current. */
  render(gl: WebGLRenderer, material: RawShaderMaterial): void {
    const next = 1 - this.currentIndex;
    const previousTarget = gl.getRenderTarget();
    const previousAutoClear = gl.autoClear;
    gl.autoClear = false;
    this.mesh.material = material;
    gl.setRenderTarget(this.targets[next]);
    gl.render(this.scene, this.camera);
    gl.setRenderTarget(previousTarget);
    gl.autoClear = previousAutoClear;
    this.currentIndex = next;
  }

  /** Replaces the state with `state`, NCA_CHANNELS per cell, row 0 lowest in pitch. */
  load(gl: WebGLRenderer, state: Float32Array): void {
    const cells = NCA_GRID * NCA_GRID;
    const textures = Array.from({ length: TARGETS }, (_, k) => {
      const data = new Float32Array(cells * 4);
      for (let cell = 0; cell < cells; cell++) {
        for (let c = 0; c < 4; c++) data[cell * 4 + c] = state[cell * NCA_CHANNELS + k * 4 + c];
      }
      return floatTexture(data, NCA_GRID, NCA_GRID);
    });
    const material = new RawShaderMaterial({
      uniforms: {
        ncaState0: { value: textures[0] },
        ncaState1: { value: textures[1] },
        ncaState2: { value: textures[2] },
        ncaGrid: { value: NCA_GRID },
      },
      vertexShader: passThroughVert,
      fragmentShader: ncaLoadFrag,
      glslVersion: GLSL3,
    });
    this.render(gl, material);
    material.dispose();
    textures.forEach((t) => t.dispose());
  }

  /** Runs the automaton `count` steps from the current state. */
  step(gl: WebGLRenderer, count: number, fireAll = false): void {
    if (!this.weightsTexture) return;
    const uniforms = this.stepMaterial.uniforms;
    uniforms.ncaWeights.value = this.weightsTexture;
    uniforms.ncaFireAll.value = fireAll;
    for (let i = 0; i < count; i++) {
      const textures = this.current.textures;
      uniforms.ncaState0.value = textures[0];
      uniforms.ncaState1.value = textures[1];
      uniforms.ncaState2.value = textures[2];
      // Each step draws a fresh set of firing cells.
      uniforms.ncaStepSeed.value = (this.steps++ % 9973) + 1;
      this.render(gl, this.stepMaterial);
    }
  }

  /** The current state, NCA_CHANNELS per cell. */
  read(gl: WebGLRenderer): Float32Array {
    const cells = NCA_GRID * NCA_GRID;
    const state = new Float32Array(cells * NCA_CHANNELS);
    const buffer = new Float32Array(cells * 4);
    for (let k = 0; k < TARGETS; k++) {
      gl.readRenderTargetPixels(this.current, 0, 0, NCA_GRID, NCA_GRID, buffer, undefined, k);
      for (let cell = 0; cell < cells; cell++) {
        for (let c = 0; c < 4; c++) state[cell * NCA_CHANNELS + k * 4 + c] = buffer[cell * 4 + c];
      }
    }
    return state;
  }

  dispose(): void {
    this.targets.forEach((t) => t.dispose());
    this.stepMaterial.dispose();
    this.mesh.geometry.dispose();
    this.weightsTexture?.dispose();
  }
}
