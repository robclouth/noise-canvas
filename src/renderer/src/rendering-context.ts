import { SpectrogramData, runSynthesis } from "@/store";
import * as THREE from "three";
import { brushes } from "./components/brushes";
import { unitsToUv } from "./components/brushes/common";
import { copyMaterial } from "./components/copy-material";
import { displayMaterial } from "./components/display-material";

// Interface for parameters needed for a brush stroke
export interface BrushParams {
  brushType: string;
  brushCenterUv: THREE.Vector2;
  brushSizeUv: THREE.Vector2;
  brushIntensity: number;
  featherX: number;
  featherY: number;
  pan: number;
  offsetUv: THREE.Vector2;
  zoomPower: number;
  scroll: number;
  crossFileTexture: THREE.Texture | null;
}

// Interface for parameters needed to update the display shader each frame
export interface UniformParams {
  bpm: number;
  gridSize: number;
  zoomPower: number;
  scroll: number;
  featherX: number;
  featherY: number;
  mouseUv: THREE.Vector2 | null;
  brushWidth: number; // in beats
  brushHeight: number; // in semitones
  bandsPerOctave: number;
  offsetX: number;
  offsetY: number;
}

export class RenderingContext {
  private gl: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  spectrogramData: SpectrogramData;

  private fbo1: THREE.WebGLRenderTarget;
  private fbo2: THREE.WebGLRenderTarget;
  private pingPong = 0;

  mesh: THREE.Mesh;

  constructor(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, spectrogramData: SpectrogramData) {
    this.gl = gl;
    this.scene = scene;
    this.camera = camera;
    this.spectrogramData = spectrogramData;

    const textureSize = this.spectrogramData.packedTextureSize;
    const options = {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    };
    this.fbo1 = new THREE.WebGLRenderTarget(textureSize.x, textureSize.y, options);
    this.fbo2 = new THREE.WebGLRenderTarget(textureSize.x, textureSize.y, options);

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));

    // Use a local scene to render the initial texture
    const localScene = new THREE.Scene();
    localScene.add(this.mesh);

    this.mesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = this.spectrogramData.packedDataTex;

    this.gl.setRenderTarget(this.fbo1);
    this.gl.render(localScene, this.camera);
    this.gl.setRenderTarget(null);

    this.mesh.material = displayMaterial;

    this.updateDisplayTexture();
  }

  private updateDisplayTexture() {
    const source = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    displayMaterial.uniforms.packedDataTex.value = source.texture;
  }

  updateUniforms(params: UniformParams) {
    const {
      bpm,
      gridSize,
      zoomPower,
      scroll,
      featherX,
      featherY,
      mouseUv,
      brushWidth,
      brushHeight,
      bandsPerOctave,
      offsetX,
      offsetY,
    } = params;

    const totalDuration = this.spectrogramData.numFrames / this.spectrogramData.sampleRate;
    const offsetUv = unitsToUv(offsetX, offsetY, bpm, totalDuration, bandsPerOctave, this.spectrogramData.numBands);

    displayMaterial.uniforms.inverseMapTex.value = this.spectrogramData.inverseMapTex;
    displayMaterial.uniforms.metadataTex.value = this.spectrogramData.metadataTex;
    displayMaterial.uniforms.numFrames.value = this.spectrogramData.numFrames;
    displayMaterial.uniforms.numBands.value = this.spectrogramData.numBands;
    displayMaterial.uniforms.numChannels.value = this.spectrogramData.numChannels;
    displayMaterial.uniforms.packedTextureSize.value = this.spectrogramData.packedTextureSize;
    displayMaterial.uniforms.bpm.value = bpm;
    displayMaterial.uniforms.gridSize.value = gridSize;
    displayMaterial.uniforms.sampleRate.value = this.spectrogramData.sampleRate;
    displayMaterial.uniforms.zoomPower.value = zoomPower;
    displayMaterial.uniforms.scroll.value = scroll;
    displayMaterial.uniforms.featherX.value = featherX / 100;
    displayMaterial.uniforms.featherY.value = featherY / 100;
    displayMaterial.uniforms.offsetUv.value.copy(offsetUv);

    if (mouseUv) {
      const brushSizeUv = unitsToUv(
        brushWidth,
        brushHeight,
        bpm,
        totalDuration,
        bandsPerOctave,
        this.spectrogramData.numBands,
      );
      displayMaterial.uniforms.brushCenterUv.value.copy(mouseUv);
      displayMaterial.uniforms.brushSizeUv.value.copy(brushSizeUv);
    } else {
      displayMaterial.uniforms.brushSizeUv.value.set(0, 0);
    }
  }

  renderStroke(params: BrushParams) {
    const { brushType, crossFileTexture, ...rest } = params;

    const source = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const destination = this.pingPong === 0 ? this.fbo2 : this.fbo1;

    const brush = brushes[brushType];
    this.mesh.material = brush.material;

    brush.updateUniforms({
      sourceTexture: source.texture,
      crossFileTexture,
      ...rest,
    });

    // Also use a local scene for brush strokes
    const localScene = new THREE.Scene();
    localScene.add(this.mesh);

    this.gl.setRenderTarget(destination);
    this.gl.render(localScene, this.camera);
    this.gl.setRenderTarget(null);

    this.mesh.material = displayMaterial;
    this.pingPong = 1 - this.pingPong;
    this.updateDisplayTexture();
  }

  getFBOData(): Float32Array | null {
    const textureSize = this.spectrogramData.packedTextureSize;
    const fboToRead = this.pingPong === 0 ? this.fbo1 : this.fbo2;
    const buffer = new Float32Array(textureSize.x * textureSize.y * 4);
    this.gl.getContext().finish();
    this.gl.readRenderTargetPixels(fboToRead, 0, 0, textureSize.x, textureSize.y, buffer);
    return buffer;
  }

  setFBOData(data: Float32Array) {
    const textureSize = this.spectrogramData.packedTextureSize;
    const destination = this.pingPong === 0 ? this.fbo1 : this.fbo2;

    const dataTex = new THREE.DataTexture(data, textureSize.x, textureSize.y, THREE.RGBAFormat, THREE.FloatType);
    dataTex.needsUpdate = true;

    this.mesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = dataTex;

    const localScene = new THREE.Scene();
    localScene.add(this.mesh);

    this.gl.setRenderTarget(destination);
    this.gl.render(localScene, this.camera);
    this.gl.setRenderTarget(null);

    this.mesh.material = displayMaterial;
    this.updateDisplayTexture();

    dataTex.dispose();
  }

  async triggerSynthesis(): Promise<void> {
    const buffer = this.getFBOData();
    if (buffer) {
      await runSynthesis(buffer);
    }
  }

  getFBO(): THREE.WebGLRenderTarget | null {
    return this.pingPong === 0 ? this.fbo1 : this.fbo2;
  }
}
