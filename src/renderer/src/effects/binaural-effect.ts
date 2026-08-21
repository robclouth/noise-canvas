import { getNumberParameterDef } from "@renderer/parameters";
import { ClampToEdgeWrapping, DataTexture, FloatType, GLSL3, LinearFilter, RawShaderMaterial, RGBAFormat } from "three";
import binauralEffectFrag from "../glsl/binaural-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { loadHrtfData, getHrtfMetadata, HrtfMetadata } from "../lib/hrtf-loader";
import { useStore } from "../store";
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

/**
 * Creates a placeholder HRTF texture (1x1, neutral values).
 */
function createPlaceholderHrtfTexture(): DataTexture {
  const data = new Float32Array(4);
  data[0] = 1.0; // magL
  data[1] = 0.0; // phaseL
  data[2] = 1.0; // magR
  data[3] = 0.0; // phaseR

  const tex = new DataTexture(data, 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

class BinauralEffect extends BaseEffect {
  hrtfTexture: DataTexture;
  hrtfMetadata: HrtfMetadata;
  hrtfLoaded = false;

  constructor() {
    super();

    // Create placeholder texture until HRTF loads
    this.hrtfTexture = createPlaceholderHrtfTexture();
    this.hrtfMetadata = getHrtfMetadata();

    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          // HRTF texture uniforms
          hrtfTex: { value: this.hrtfTexture },
          hrtfMinFreq: { value: this.hrtfMetadata.minFreq },
          hrtfMaxFreq: { value: this.hrtfMetadata.maxFreq },
          hrtfNumAzimuths: { value: this.hrtfMetadata.numAzimuths },
          hrtfNumFreqBands: { value: this.hrtfMetadata.numFrequencyBands },
          // Effect parameters
          azimuth: { value: defaultParameterUniform(0.0, -180.0, 180.0) },
          distance: { value: defaultParameterUniform(1.0, 0.1, 10.0) },
          stereoAngle: { value: defaultParameterUniform(180.0, 0.0, 180.0) },
        },
        vertexShader: passThroughVert,
        fragmentShader: binauralEffectFrag,
        glslVersion: GLSL3,
      }),
    ];

    // Load HRTF data asynchronously
    this.loadHrtf();
  }

  async loadHrtf(): Promise<void> {
    try {
      const { texture, metadata } = await loadHrtfData();
      // The placeholder held a GPU texture no material will reference again.
      this.hrtfTexture.dispose();
      this.hrtfTexture = texture;
      this.hrtfMetadata = metadata;
      this.hrtfLoaded = true;

      // Update all materials with the loaded texture
      for (const material of this.materials) {
        material.uniforms.hrtfTex.value = texture;
        material.uniforms.hrtfMinFreq.value = metadata.minFreq;
        material.uniforms.hrtfMaxFreq.value = metadata.maxFreq;
        material.uniforms.hrtfNumAzimuths.value = metadata.numAzimuths;
        material.uniforms.hrtfNumFreqBands.value = metadata.numFrequencyBands;
      }

      console.log("[Binaural] HRTF texture loaded successfully");
    } catch (error) {
      console.warn("[Binaural] Failed to load HRTF data:", error);
    }
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const material = this.materials[props.passIndex];

    if (!material) return;

    // Ensure HRTF texture is set (in case it loaded after construction)
    if (this.hrtfLoaded) {
      material.uniforms.hrtfTex.value = this.hrtfTexture;
      material.uniforms.hrtfMinFreq.value = this.hrtfMetadata.minFreq;
      material.uniforms.hrtfMaxFreq.value = this.hrtfMetadata.maxFreq;
      material.uniforms.hrtfNumAzimuths.value = this.hrtfMetadata.numAzimuths;
      material.uniforms.hrtfNumFreqBands.value = this.hrtfMetadata.numFrequencyBands;
    }

    // Azimuth parameter
    const azimuthValue = state.binauralAzimuth;
    const azimuthDef = getNumberParameterDef("binauralAzimuth");
    material.uniforms.azimuth.value = parameterUniform(state, "binauralAzimuth", props.modContext, {
      value: azimuthValue,
      min: azimuthDef.min,
      max: azimuthDef.max,
    });

    // Distance parameter
    const distanceValue = state.binauralDistance;
    const distanceDef = getNumberParameterDef("binauralDistance");
    material.uniforms.distance.value = parameterUniform(state, "binauralDistance", props.modContext, {
      value: distanceValue,
      min: distanceDef.min,
      max: distanceDef.max,
    });

    // Stereo angle parameter
    const stereoAngleValue = state.binauralStereoAngle;
    const stereoAngleDef = getNumberParameterDef("binauralStereoAngle");
    material.uniforms.stereoAngle.value = parameterUniform(state, "binauralStereoAngle", props.modContext, {
      value: stereoAngleValue,
      min: stereoAngleDef.min,
      max: stereoAngleDef.max,
    });
  }
}

export const binauralEffect = new BinauralEffect();
