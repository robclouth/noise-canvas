import { openFiles, useStore } from "@/store";
import { useFBO } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { runSynthesis } from "@renderer/audio-manager";
import { CommonUniforms, defaultValues } from "@renderer/effects/base-effect";
import { NUM_MODULATORS } from "@renderer/lib/constants";
import { ContinuousNumberParameter } from "@renderer/types";
import { debounce } from "lodash-es";
import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ShaderMaterial, UniformsUtils } from "three";
import { effects } from "../effects";
import displayFrag from "../glsl/display.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { unitsToUv } from "../lib/utils";
import { copyMaterial } from "./copy-material";

/**
 * Props for the FileRenderer component.
 * @param file - The open file to render.
 */
interface FileRendererProps {
  filePath: string;
}

/**
 * Handle for the FileRenderer component, exposing methods to parent components.
 */
export interface FileRendererHandle {
  /** Renders a brush stroke at the given coordinates. */
  renderStroke: (x: number, y: number, preview: boolean) => void;
  /** Gets the raw data from the current frame buffer object. */
  getFBOData: () => Float32Array;
  /** Sets the data of the frame buffer object. */
  setFBOData: (data: Float32Array) => void;
  /** Returns the textures used for rendering. */
  getTextures: () => {
    packed: THREE.WebGLRenderTarget;
    inverse: THREE.DataTexture;
    metadata: THREE.DataTexture;
    original: THREE.DataTexture;
  } | null;
  /** Restores the spectrogram to its original state. */
  restoreOriginal: () => void;
  /** Triggers audio synthesis from the current spectrogram data. */
  synthesize: () => void;
  /** Clears the stroke preview. */
  clearPreview: () => void;
}

/**
 * The `FileRenderer` component is responsible for rendering the spectrogram of an audio file
 * and handling real-time brush interactions for editing the spectrogram data.
 * It uses `react-three-fiber` for rendering and manages textures and frame buffer objects (FBOs)
 * for processing and displaying the spectrogram.
 */
export const FileRenderer = memo(
  forwardRef<FileRendererHandle, FileRendererProps>(({ filePath }, ref) => {
    const { spectrogramData } = openFiles[filePath];
    const { gl, camera, invalidate } = useThree();

    const modulatorScaleLut = useModulatorScaleLut(filePath);

    // Textures for spectrogram data
    const [packedDataTex, setPackedDataTex] = useState<THREE.DataTexture | null>(null);
    const [originalPackedDataTex, setOriginalPackedDataTex] = useState<THREE.DataTexture | null>(null);
    const [inverseMapTex, setInverseMapTex] = useState<THREE.DataTexture | null>(null);
    const [metadataTex, setMetadataTex] = useState<THREE.DataTexture | null>(null);

    // Interaction state
    const mouseUv = useRef<THREE.Vector2 | null>(null);
    const displayMode = useRef<"preview" | "committed">("committed");
    const applyStroke = useRef(false);

    console.log("FileRenderer rendered");

    // Subscriptions to global state
    useEffect(() => {
      const unsubMouseUv = useStore.subscribe(
        (state) => state.mousePos,
        (mousePos) => {
          mouseUv.current = mousePos;
        },
      );
      const unsubBpms = useStore.subscribe(
        (state) => state.filesBpm[filePath],
        () => {
          invalidate();
        },
      );

      return () => {
        unsubMouseUv();
        unsubBpms();
      };
    }, [filePath, invalidate]);

    // Materials and scene objects for rendering
    const displayMaterial = useMemo(
      () =>
        new ShaderMaterial({
          uniforms: {
            ...UniformsUtils.clone(defaultValues),
            minDb: { value: -70.0 },
            maxDb: { value: 0.0 },
            bpm: { value: 120.0 },
            gridSize: { value: 0.25 },
            isSourceFile: { value: true },
            isTargetFile: { value: true },
          },
          vertexShader: passThroughVert,
          fragmentShader: displayFrag,
        }),
      [],
    );

    const mesh = useRef<THREE.Mesh>(null!);
    const { scene: fboScene, mesh: fboMesh } = useMemo(() => {
      const scene = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
      scene.add(mesh);
      return { scene, mesh };
    }, []);

    // Frame Buffer Objects for ping-pong rendering
    const fbo1 = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });

    const fbo2 = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });

    const passFbo1 = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });

    const passFbo2 = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });

    // Rendering state
    const pingPong = useRef(0);
    const isInitialized = useRef(false);

    const strokeParams = useRef<{ x: number; y: number; preview: boolean } | null>(null);

    // Effect to create and manage spectrogram textures
    useEffect(() => {
      const { packedData, inverseMap, metadata, textureWidth, textureHeight, numBands } = spectrogramData;

      const packed = new THREE.DataTexture(packedData, textureWidth, textureHeight, THREE.RGBAFormat, THREE.FloatType);
      packed.internalFormat = "RGBA32F";
      packed.minFilter = THREE.NearestFilter;
      packed.magFilter = THREE.NearestFilter;
      packed.needsUpdate = true;

      const inverse = new THREE.DataTexture(inverseMap, textureWidth, textureHeight, THREE.RGFormat, THREE.FloatType);
      inverse.internalFormat = "RG32F";
      inverse.minFilter = THREE.NearestFilter;
      inverse.magFilter = THREE.NearestFilter;
      inverse.needsUpdate = true;

      const meta = new THREE.DataTexture(metadata, numBands, 1, THREE.RGBFormat, THREE.FloatType);
      meta.internalFormat = "RGB32F";
      meta.minFilter = THREE.NearestFilter;
      meta.magFilter = THREE.NearestFilter;
      meta.needsUpdate = true;

      setPackedDataTex(packed);
      setOriginalPackedDataTex(packed.clone());
      setInverseMapTex(inverse);
      setMetadataTex(meta);

      // Reset render tracking when textures change
      isInitialized.current = false;

      return () => {
        packed.dispose();
        inverse.dispose();
        meta.dispose();
        setPackedDataTex(null);
        setOriginalPackedDataTex(null);
        setInverseMapTex(null);
        setMetadataTex(null);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      spectrogramData.packedData,
      spectrogramData.inverseMap,
      spectrogramData.metadata,
      spectrogramData.textureWidth,
      spectrogramData.textureHeight,
      spectrogramData.numBands,
    ]);

    const debouncedSynthesis = useMemo(() => debounce(runSynthesis, 500, { leading: false, trailing: true }), []);

    useEffect(() => {
      return () => {
        debouncedSynthesis.cancel();
      };
    }, [debouncedSynthesis]);

    /**
     * The main render loop, called on every frame.
     * This handles initialization, brush stroke application, and updating the display material.
     */
    useFrame(({ gl, camera }) => {
      if (
        !fboMesh ||
        !spectrogramData ||
        !packedDataTex ||
        !inverseMapTex ||
        !metadataTex ||
        !fbo1 ||
        !fbo2 ||
        !originalPackedDataTex
      )
        return;

      const state = useStore.getState();

      // Initial copy of the spectrogram data to the FBO
      const needsInitialization = !isInitialized.current;
      if (needsInitialization) {
        fboMesh.material = copyMaterial;
        copyMaterial.uniforms.inputTex.value = packedDataTex;

        gl.setRenderTarget(fbo1);
        gl.render(fboScene, camera);
        gl.setRenderTarget(null);

        pingPong.current = 0;

        window.api.addUndoState({ data: spectrogramData.packedData.buffer, filePath });
        debouncedSynthesis(filePath, spectrogramData.packedData);
        // Continue to initial render - don't skip on first frame
      }

      // After first render, only update if this file is the active file or the source file
      if (isInitialized.current) {
        const isActiveFile = state.activeFilePath === filePath;
        const isSourceFile = state.sourceFile?.path === filePath;
        if (!isActiveFile && !isSourceFile) {
          return;
        }

        // If no stroke to apply and already initialized, skip expensive uniform building
        if (!applyStroke.current) {
          // Only update display uniforms
          const currentFBO = pingPong.current === 0 ? fbo1 : fbo2;
          const nextFBO = pingPong.current === 0 ? fbo2 : fbo1;
          const bpm = state.filesBpm[filePath] || 120;

          displayMaterial.uniforms.sourceSpectrogramTex.value =
            displayMode.current === "committed" ? currentFBO.texture : nextFBO.texture;
          displayMaterial.uniforms.gridSize.value = state.gridSizeBeats.value;
          displayMaterial.uniforms.bpm.value = bpm;
          displayMaterial.uniforms.isSourceFile.value = state.sourceFile?.path === filePath;
          displayMaterial.uniforms.isTargetFile.value = isActiveFile;
          displayMaterial.uniforms.brushCenterUv.value = mouseUv.current || new THREE.Vector2(-1, -1);
          return;
        }
      }

      const sourceFile = state.sourceFile?.path ? openFiles[state.sourceFile.path] : null;
      if (!sourceFile) return;

      // Get current brush and view parameters from the global store
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const sourceTotalDuration = sourceFile.spectrogramData.numFrames / sourceFile.spectrogramData.sampleRate;

      const sourceRendererRef = openFiles[sourceFile.filePath].rendererRef;

      const textures = sourceRendererRef?.current?.getTextures();
      if (!textures) return;

      // Determine the current FBO for reading
      const currentReadFBO = pingPong.current === 0 ? fbo1 : fbo2;
      const bpm = state.filesBpm[filePath] || 120;
      const sourceBpm = state.filesBpm[sourceFile.filePath] || 120;

      const sourceOffsetUv = unitsToUv(
        state.sourceOffsetBeats.value,
        state.sourceOffsetSemis.value,
        sourceBpm,
        sourceTotalDuration,
        sourceFile.spectrogramData.bandsPerOctave,
        sourceFile.spectrogramData.numBands,
      );

      const brushSizeUv = unitsToUv(
        state.brushWidthBeats.value,
        state.brushHeightSemis.value,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );
      // Handle full brush size (when brush width or height is 0)
      brushSizeUv.x = state.brushWidthBeats.value > 0 ? brushSizeUv.x : 1;
      brushSizeUv.y = state.brushHeightSemis.value > 0 ? brushSizeUv.y : 1;

      // Set up common uniforms for the brush shaders
      const commonUniforms: CommonUniforms = {
        sourceSpectrogramTex: { value: textures.packed.texture },
        sourceSpectrogramTextureSize: { value: sourceFile.spectrogramData.packedTextureSize },
        sourceInverseMapTex: { value: textures.inverse },
        sourceMetadataTex: { value: textures.metadata },
        sourceMinFreq: { value: sourceFile.spectrogramData.minFreq },
        sourceBandsPerOctave: { value: sourceFile.spectrogramData.bandsPerOctave },
        sourceFrameCount: { value: sourceFile.spectrogramData.numFrames },
        sourceBandCount: { value: sourceFile.spectrogramData.numBands },
        sourceChannelCount: { value: sourceFile.spectrogramData.numChannels },
        sourceSampleRate: { value: sourceFile.spectrogramData.sampleRate },
        destSpectrogramTex: { value: currentReadFBO.texture },
        destSpectrogramTextureSize: { value: spectrogramData.packedTextureSize },
        destInverseMapTex: { value: inverseMapTex },
        destMetadataTex: { value: metadataTex },
        destMinFreq: { value: spectrogramData.minFreq },
        destBandsPerOctave: { value: spectrogramData.bandsPerOctave },
        destFrameCount: { value: spectrogramData.numFrames },
        destBandCount: { value: spectrogramData.numBands },
        destChannelCount: { value: spectrogramData.numChannels },
        destSampleRate: { value: spectrogramData.sampleRate },
        originalSpectrogramTex: { value: originalPackedDataTex },
        viewZoomPower: { value: state.zoomPower.value },
        viewOffset: { value: state.scroll.value },
        brushCenterUv: { value: mouseUv.current || new THREE.Vector2(-1, -1) },
        brushSizeUv: { value: brushSizeUv },
        featherX: { value: state.brushFeatherTime.value / 100 },
        featherY: { value: state.brushFeatherPitch.value / 100 },
        featherSlopeTime: { value: state.brushFeatherSlopeTime.value / 100 },
        featherSlopePitch: { value: state.brushFeatherSlopePitch.value / 100 },
        brushIntensity: {
          value: {
            value: state.brushIntensity.value / 100,
            minValue: state.brushIntensity.min / 100,
            maxValue: state.brushIntensity.max / 100,
            modulationAmounts:
              state.brushIntensity.modulatorParamKeys?.map(
                (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
              ) || [],
          },
        },
        brushPan: {
          value: {
            value: state.brushPan.value / 100,
            minValue: state.brushPan.min / 100,
            maxValue: state.brushPan.max / 100,
            modulationAmounts:
              state.brushPan.modulatorParamKeys?.map(
                (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
              ) || [],
          },
        },
        bpm: { value: bpm },
        sourceOffsetX: {
          value: {
            value: sourceOffsetUv.x,
            minValue: 0.0,
            maxValue: 1.0,
            modulationAmounts:
              state.sourceOffsetBeats.modulatorParamKeys?.map(
                (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
              ) || [],
          },
        },

        sourceOffsetY: {
          value: {
            value: sourceOffsetUv.y,
            minValue: 0.0,
            maxValue: 1.0,
            modulationAmounts:
              state.sourceOffsetSemis.modulatorParamKeys?.map(
                (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
              ) || [],
          },
        },
        blendMode: { value: state.blendMode.value },
        modulators: {
          value: Array.from({ length: NUM_MODULATORS }).map((_, i) => {
            const modulatorPatternRate = unitsToUv(
              state[`modulator${i + 1}PatternRateBeats`].value,
              state[`modulator${i + 1}PatternRateSemis`].value,
              bpm,
              totalDuration,
              spectrogramData.bandsPerOctave,
              spectrogramData.numBands,
            );

            // Calculate min/max for pattern rates in UV space
            const maxBeats = 64; // Maximum beat value from BEAT_VALUES
            const maxSemis = 96; // Maximum semitone value from PITCH_VALUES
            const maxRateUv = unitsToUv(
              maxBeats,
              maxSemis,
              bpm,
              totalDuration,
              spectrogramData.bandsPerOctave,
              spectrogramData.numBands,
            );

            return {
              modulatorMode: state[`modulator${i + 1}Mode`].value,
              modulatorPatternShape: state[`modulator${i + 1}PatternShape`].value,
              modulatorPatternRateX: {
                value: modulatorPatternRate.x,
                minValue: 0.0,
                maxValue: maxRateUv.x,
                modulationAmounts:
                  state[`modulator${i + 1}PatternRateBeats`].modulatorParamKeys?.map(
                    (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
                  ) || [],
              },
              modulatorPatternRateY: {
                value: modulatorPatternRate.y,
                minValue: 0.0,
                maxValue: maxRateUv.y,
                modulationAmounts:
                  state[`modulator${i + 1}PatternRateSemis`].modulatorParamKeys?.map(
                    (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
                  ) || [],
              },
              modulatorStrength: {
                value: state[`modulator${i + 1}Strength`].value / 100,
                minValue: -1.0,
                maxValue: 1.0,
                modulationAmounts:
                  state[`modulator${i + 1}Strength`].modulatorParamKeys?.map(
                    (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
                  ) || [],
              },
              modulatorRotation: {
                value: state[`modulator${i + 1}Rotation`].value,
                minValue: 0.0,
                maxValue: 360.0,
                modulationAmounts:
                  state[`modulator${i + 1}Rotation`].modulatorParamKeys?.map(
                    (paramKey) => (state[paramKey] as ContinuousNumberParameter).value / 100,
                  ) || [],
              },
            };
          }),
        },
        gainLut: { value: modulatorScaleLut || new THREE.Texture() },
      };

      console.log("useFrame called");

      // Render brush stroke if requested
      if (strokeParams.current && applyStroke.current) {
        const destinationFbo = pingPong.current === 0 ? fbo2 : fbo1;
        const currentFbo = pingPong.current === 0 ? fbo1 : fbo2;
        const { preview } = strokeParams.current;

        // Get enabled effects in order
        const enabledEffects = state.effectOrder.filter((effectId) => state.effectsEnabled[effectId]);

        // If no effects are enabled, add a passthrough effect to properly handle metadata conversion
        if (enabledEffects.length === 0) {
          enabledEffects.push("passthrough");
        }

        // Determine the source FBO based on sourceMode and which file is the source
        // "current" means we read from the current modified spectrogram
        // "original" means we read from the original unmodified source
        const isSameFile = sourceFile.filePath === filePath;
        const sourceFbo =
          state.sourceFile?.mode === "original"
            ? { texture: textures.original } // Use original unmodified data
            : isSameFile
              ? currentFbo // Same file: use our own current modified FBO
              : textures.packed; // Different file: use their current modified FBO

        // Override the source texture in commonUniforms to use the correct source
        commonUniforms.sourceSpectrogramTex.value = sourceFbo.texture;

        // Create the uniform set for iterative passes (j > 0).
        // This tells the shader to interpret the input texture using the destination's metadata.
        const iterativeUniforms = {
          ...commonUniforms,
          sourceInverseMapTex: commonUniforms.destInverseMapTex,
          sourceMetadataTex: commonUniforms.destMetadataTex,
          sourceMinFreq: commonUniforms.destMinFreq,
          sourceBandsPerOctave: commonUniforms.destBandsPerOctave,
          sourceFrameCount: commonUniforms.destFrameCount,
          sourceBandCount: commonUniforms.destBandCount,
          sourceChannelCount: commonUniforms.destChannelCount,
          sourceSampleRate: commonUniforms.destSampleRate,
          sourceSpectrogramTextureSize: commonUniforms.destSpectrogramTextureSize,
        };

        let tempFboA = passFbo1;
        let tempFboB = passFbo2;

        // The input for the very first pass is always the original source data.
        let currentReadFbo = sourceFbo;

        // Apply each enabled effect in order, with iterations
        for (let effectIndex = 0; effectIndex < enabledEffects.length; effectIndex++) {
          const effectId = enabledEffects[effectIndex];
          const effect = effects[effectId];
          const numPasses = effect.materials.length;

          for (let i = 0; i < state.brushIterations.value; i++) {
            for (let p = 0; p < numPasses; p++) {
              const isFirstEffect = effectIndex === 0;
              const isFirstIteration = i === 0;
              const isFirstPass = p === 0;
              const uniformsForThisIteration =
                isFirstEffect && isFirstIteration && isFirstPass ? { ...commonUniforms } : { ...iterativeUniforms };

              const material = effect.materials[p];
              fboMesh.material = material;

              const isLastEffect = effectIndex === enabledEffects.length - 1;
              const isLastIteration = i === state.brushIterations.value - 1;
              const isLastPass = p === numPasses - 1;
              const isFinalPass = isLastEffect && isLastIteration && isLastPass;
              const currentWriteFbo = isFinalPass ? destinationFbo : tempFboA;

              const inputTexture = currentReadFbo.texture;

              // The "source" is always the result of the previous pass.
              uniformsForThisIteration.sourceSpectrogramTex = { value: inputTexture };

              // The "destination" (for blending) is the original target on the first pass.
              // For all subsequent iterative passes, the destination is the source (self-modification).
              uniformsForThisIteration.destSpectrogramTex = {
                value: isFirstEffect && isFirstIteration ? commonUniforms.destSpectrogramTex.value : inputTexture,
              };

              effect.updateEffectUniforms({
                commonUniforms: uniformsForThisIteration,
                passIndex: p,
                file: sourceFile,
              });

              gl.setRenderTarget(currentWriteFbo);
              gl.render(fboScene, camera);

              currentReadFbo = currentWriteFbo;

              if (!isFinalPass) {
                [tempFboA, tempFboB] = [tempFboB, tempFboA];
              }
            }
          }
        }

        gl.setRenderTarget(null);

        // If the stroke is not a preview, commit the changes
        if (!preview) {
          pingPong.current = 1 - pingPong.current;
          displayMode.current = "committed";

          useStore.getState().setIsSynthesizing(true);
          const buffer = getFBOData();
          debouncedSynthesis(filePath, buffer);
        }
      }

      // Update the display material with the latest FBO texture and uniforms
      const currentFBO = pingPong.current === 0 ? fbo1 : fbo2;
      const nextFBO = pingPong.current === 0 ? fbo2 : fbo1;

      const displayUniforms = {
        ...commonUniforms,
        sourceSpectrogramTex: { value: displayMode.current === "committed" ? currentFBO.texture : nextFBO.texture },
        sourceInverseMapTex: { value: inverseMapTex },
        sourceMetadataTex: { value: metadataTex },
        sourceMinFreq: { value: spectrogramData.minFreq },
        sourceBandsPerOctave: { value: spectrogramData.bandsPerOctave },
        sourceFrameCount: { value: spectrogramData.numFrames },
        sourceBandCount: { value: spectrogramData.numBands },
        sourceChannelCount: { value: spectrogramData.numChannels },
        sourceSampleRate: { value: spectrogramData.sampleRate },
        sourceSpectrogramTextureSize: { value: spectrogramData.packedTextureSize },
        gridSize: { value: state.gridSizeBeats.value },
        bpm: { value: bpm },
        isSourceFile: { value: sourceFile?.filePath === filePath },
        isTargetFile: { value: state.activeFilePath === filePath },
      };

      for (const key in displayUniforms) {
        if (key in displayMaterial.uniforms) {
          displayMaterial.uniforms[key].value = displayUniforms[key].value;
        }
      }

      if (applyStroke.current) applyStroke.current = false;

      // Mark that we've completed at least one full render (including initialization if needed)
      isInitialized.current = true;
    });

    /**
     * Reads the pixel data from the current FBO.
     */
    const getFBOData = (): Float32Array => {
      const { packedTextureSize } = spectrogramData;
      const fboToRead = pingPong.current === 0 ? fbo1 : fbo2;
      const buffer = new Float32Array(packedTextureSize.x * packedTextureSize.y * 4);
      gl.getContext().finish();
      gl.readRenderTargetPixels(fboToRead, 0, 0, packedTextureSize.x, packedTextureSize.y, buffer);
      return buffer;
    };

    /**
     * Sets the FBO data from an external source (e.g., for undo/redo).
     */
    const setFBOData = (data: Float32Array) => {
      if (!spectrogramData || !fbo1 || !fbo2 || !fboMesh) return;
      const { packedTextureSize } = spectrogramData;

      pingPong.current = 0;

      const dataTex = new THREE.DataTexture(
        data,
        packedTextureSize.x,
        packedTextureSize.y,
        THREE.RGBAFormat,
        THREE.FloatType,
      );
      dataTex.needsUpdate = true;

      gl.initTexture(dataTex);

      fboMesh.material = copyMaterial;
      copyMaterial.uniforms.inputTex.value = dataTex;

      gl.setRenderTarget(fbo1);
      gl.render(fboScene, camera);
      gl.setRenderTarget(null);

      dataTex.dispose();

      applyStroke.current = false;
      displayMode.current = "committed";

      invalidate();
    };

    /**
     * Returns the current set of textures.
     */
    const getTextures = (): {
      packed: THREE.WebGLRenderTarget;
      inverse: THREE.DataTexture;
      metadata: THREE.DataTexture;
      original: THREE.DataTexture;
    } | null => {
      if (!fbo1 || !fbo2 || !inverseMapTex || !metadataTex || !originalPackedDataTex) return null;
      return {
        packed: pingPong.current === 0 ? fbo1 : fbo2,
        inverse: inverseMapTex,
        metadata: metadataTex,
        original: originalPackedDataTex,
      };
    };

    /**
     * Restores the spectrogram to its original, unmodified state.
     */
    const restoreOriginal = () => {
      isInitialized.current = false;

      invalidate();
      debouncedSynthesis(filePath, getFBOData());
    };

    /**
     * Triggers audio synthesis for the current state of the spectrogram.
     */
    const synthesize = () => {
      useStore.getState().setIsSynthesizing(true);
      const buffer = getFBOData();
      debouncedSynthesis(filePath, buffer);
    };

    /**
     * Exposes component methods to the parent through a ref.
     */
    useImperativeHandle(ref, () => ({
      renderStroke: (x: number, y: number, preview: boolean) => {
        strokeParams.current = { x, y, preview };
        if (preview) {
          displayMode.current = "preview";
        }
        applyStroke.current = true;
        invalidate();
      },
      getFBOData,
      setFBOData,
      getTextures,
      restoreOriginal,
      synthesize,
      clearPreview,
    }));

    if (!spectrogramData) {
      return null;
    }

    /**
     * Clears the stroke preview from the display.
     */
    const clearPreview = () => {
      displayMode.current = "committed";
      invalidate();
    };

    // The component renders a mesh with a plane geometry and the custom `displayMaterial`.
    return (
      <mesh ref={mesh}>
        <planeGeometry args={[2, 2]} />
        <primitive object={displayMaterial} attach="material" />
      </mesh>
    );
  }),
);

FileRenderer.displayName = "FileRenderer";
