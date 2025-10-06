import { openFiles, useStore } from "@/store";
import { useFrame } from "@react-three/fiber";
import { runSynthesis } from "@renderer/audio-manager";
import { CommonUniforms, defaultValues } from "@renderer/effects/base-effect";
import { NUM_MODULATORS } from "@renderer/lib/constants";
import { ContinuousNumberParameter } from "@renderer/types";
import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ShaderMaterial, UniformsUtils } from "three";
import { effects } from "../effects";
import displayFrag from "../glsl/display.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { readRenderTargetPixelsAsync } from "../lib/async-readpixels";
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
  /** Gets the raw data from the current frame buffer object asynchronously. */
  getFBOData: () => Promise<Float32Array>;
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
  /** Clears the stroke preview. */
  clearPreview: () => void;
  /** Reloads all textures from the current spectrogramData (used after re-analysis). */
  reloadTextures: () => void;
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

    // Don't subscribe to these during render - access them via refs or useFrame instead
    const glRef = useRef<THREE.WebGLRenderer>(null!);
    const cameraRef = useRef<THREE.Camera>(null!);
    const invalidateRef = useRef<() => void>(null!);

    const modulatorScaleLut = useModulatorScaleLut(filePath);

    // Textures for spectrogram data
    const [packedDataTex, setPackedDataTex] = useState<THREE.DataTexture | null>(null);
    const [originalPackedDataTex, setOriginalPackedDataTex] = useState<THREE.DataTexture | null>(null);
    const [inverseMapTex, setInverseMapTex] = useState<THREE.DataTexture | null>(null);
    const [metadataTex, setMetadataTex] = useState<THREE.DataTexture | null>(null);

    // Interaction state
    const displayMode = useRef<"preview" | "committed">("committed");
    const applyStroke = useRef(false);

    console.log("FileRenderer rendered");

    // Subscriptions to global state
    useEffect(() => {
      const unsubBpms = useStore.subscribe(
        (state) => state.filesBpm[filePath],
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubGridBeats = useStore.subscribe(
        (state) => state.gridSizeBeats.value,
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubGridSemis = useStore.subscribe(
        (state) => state.gridSizeSemis.value,
        () => {
          invalidateRef.current?.();
        },
      );

      return () => {
        unsubBpms();
        unsubGridBeats();
        unsubGridSemis();
      };
    }, [filePath]);

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
            gridWidthUv: { value: 0.0 },
            gridHeightUv: { value: 0.0 },
            barWidthUv: { value: 0.0 },
            showHorizontalGrid: { value: true },
            showVerticalGrid: { value: true },
            showTargetRectangle: { value: false },
            showSourceRectangle: { value: false },
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
    // Create FBOs manually to avoid useFBO's internal canvas size subscriptions
    const fbo1 = useMemo(() => {
      const fbo = new THREE.WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: THREE.RGBAFormat,
        type: THREE.FloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
      return fbo;
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    const fbo2 = useMemo(() => {
      const fbo = new THREE.WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: THREE.RGBAFormat,
        type: THREE.FloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
      return fbo;
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    const passFbo1 = useMemo(() => {
      const fbo = new THREE.WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: THREE.RGBAFormat,
        type: THREE.FloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
      return fbo;
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    const passFbo2 = useMemo(() => {
      const fbo = new THREE.WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: THREE.RGBAFormat,
        type: THREE.FloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
      return fbo;
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    // Cleanup FBOs on unmount or dimension change
    useEffect(() => {
      return () => {
        fbo1.dispose();
        fbo2.dispose();
        passFbo1.dispose();
        passFbo2.dispose();
      };
    }, [fbo1, fbo2, passFbo1, passFbo2]);

    // Rendering state
    const pingPong = useRef(0);
    const isInitialized = useRef(false);

    const strokeParams = useRef<{ x: number; y: number; preview: boolean } | null>(null);

    // FBO data cache to avoid redundant GPU readbacks
    const fboDataCache = useRef<Float32Array | null>(null);
    const fboDataDirty = useRef(true);

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

      // Invalidate cache since textures have changed
      fboDataDirty.current = true;

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

    /**
     * Helper function to calculate source offset based on position mode.
     * This consolidates the logic used for both stroke rendering and display.
     */
    const calculateSourceOffset = (
      state: ReturnType<typeof useStore.getState>,
      mousePos: THREE.Vector2 | null,
      sourceBpm: number,
      sourceTotalDuration: number,
      sourceSpectrogramData: typeof spectrogramData,
      bpm: number,
      totalDuration: number,
    ): THREE.Vector2 => {
      const sourceOffsetUv = new THREE.Vector2(0, 0);

      if (!state.sourcePosition || !mousePos) {
        return sourceOffsetUv;
      }

      const mode = state.sourcePositionMode.value;

      // Calculate brush size in the SOURCE file's coordinate space
      const brushSizeUvSource = unitsToUv(
        state.brushWidthBeats.value,
        state.brushHeightSemis.value,
        sourceBpm,
        sourceTotalDuration,
        sourceSpectrogramData.bandsPerOctave,
        sourceSpectrogramData.numBands,
      );
      const halfBrushSizeUvSource = new THREE.Vector2(brushSizeUvSource.x / 2, brushSizeUvSource.y / 2);

      // Calculate brush size in the CURRENT file's coordinate space
      const brushSizeUvCurrent = unitsToUv(
        state.brushWidthBeats.value,
        state.brushHeightSemis.value,
        bpm,
        totalDuration,
        spectrogramData.bandsPerOctave,
        spectrogramData.numBands,
      );
      const halfBrushSizeUvCurrent = new THREE.Vector2(brushSizeUvCurrent.x / 2, brushSizeUvCurrent.y / 2);

      // Convert source position (bottom-left) to UV coordinates in the source file
      const sourcePositionBottomLeftUv = unitsToUv(
        state.sourcePosition.beats,
        state.sourcePosition.pitch,
        sourceBpm,
        sourceTotalDuration,
        sourceSpectrogramData.bandsPerOctave,
        sourceSpectrogramData.numBands,
      );
      const sourcePositionUv = sourcePositionBottomLeftUv.clone().add(halfBrushSizeUvSource);
      const currentBrushUv = mousePos.clone();

      if (mode === "fixed") {
        return sourcePositionUv.clone().sub(currentBrushUv);
      } else if (mode === "anchored") {
        if (state.brushStartPosition) {
          const brushStartBottomLeftUv = unitsToUv(
            state.brushStartPosition.beats,
            state.brushStartPosition.pitch,
            bpm,
            totalDuration,
            spectrogramData.bandsPerOctave,
            spectrogramData.numBands,
          );
          const brushStartUv = brushStartBottomLeftUv.clone().add(halfBrushSizeUvCurrent);
          return sourcePositionUv.clone().sub(brushStartUv);
        } else {
          return sourcePositionUv.clone().sub(currentBrushUv);
        }
      } else if (mode === "offset") {
        if (state.lockedOffset) {
          return unitsToUv(
            state.lockedOffset.beats,
            state.lockedOffset.pitch,
            sourceBpm,
            sourceTotalDuration,
            sourceSpectrogramData.bandsPerOctave,
            sourceSpectrogramData.numBands,
          );
        } else if (state.brushStartPosition) {
          const brushStartBottomLeftUv = unitsToUv(
            state.brushStartPosition.beats,
            state.brushStartPosition.pitch,
            bpm,
            totalDuration,
            spectrogramData.bandsPerOctave,
            spectrogramData.numBands,
          );
          const brushStartUv = brushStartBottomLeftUv.clone().add(halfBrushSizeUvCurrent);
          return sourcePositionUv.clone().sub(brushStartUv);
        } else {
          return sourcePositionUv.clone().sub(currentBrushUv);
        }
      }

      return sourceOffsetUv;
    };

    /**
     * The main render loop, called on every frame.
     * This handles initialization, brush stroke application, and updating the display material.
     */
    useFrame(({ gl, camera, invalidate }) => {
      // Capture refs for use outside of useFrame
      glRef.current = gl;
      cameraRef.current = camera;
      if (!invalidateRef.current) {
        invalidateRef.current = invalidate;
      }

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
      const mousePos = state.mousePos;

      // Determine file state for rendering logic
      const isActiveFile = state.activeFilePath === filePath;
      const isSourceFile = state.sourceFile?.path === filePath;
      const isMouseOver = Boolean(mousePos && mousePos.x >= 0 && state.hoveredFilePath === filePath);
      const isMouseOverAnyFile = Boolean(mousePos && state.hoveredFilePath);

      // Initial copy of the spectrogram data to the FBO
      if (!isInitialized.current) {
        fboMesh.material = copyMaterial;
        copyMaterial.uniforms.inputTex.value = packedDataTex;

        gl.setRenderTarget(fbo1);
        gl.render(fboScene, camera);
        gl.setRenderTarget(null);

        pingPong.current = 0;
        isInitialized.current = true;

        // Invalidate cache since FBO has been initialized
        fboDataDirty.current = true;

        window.api.addUndoState({ data: spectrogramData.packedData.buffer, filePath });
        runSynthesis(filePath);
        invalidate(); // Trigger another render to update display
        return;
      }

      // After initialization, only update if this file is active, source, or mouse is hovering over it
      if (!isActiveFile && !isSourceFile && !isMouseOver) {
        return;
      }

      const bpm = state.filesBpm[filePath] || 120;
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

      // Calculate brush size for display
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

      // Render brush stroke if requested
      if (strokeParams.current && applyStroke.current) {
        const sourceFile = state.sourceFile?.path ? openFiles[state.sourceFile.path] : null;
        if (!sourceFile) return;

        const sourceRendererRef = openFiles[sourceFile.filePath].rendererRef;
        const textures = sourceRendererRef?.current?.getTextures();
        if (!textures) return;

        const sourceBpm = state.filesBpm[sourceFile.filePath] || 120;
        const sourceTotalDuration = sourceFile.spectrogramData.numFrames / sourceFile.spectrogramData.sampleRate;

        // Calculate source offset using the helper function
        const sourceOffsetUv = calculateSourceOffset(
          state,
          mousePos,
          sourceBpm,
          sourceTotalDuration,
          sourceFile.spectrogramData,
          bpm,
          totalDuration,
        );

        const currentReadFBO = pingPong.current === 0 ? fbo1 : fbo2;
        const destinationFbo = pingPong.current === 0 ? fbo2 : fbo1;
        const { preview } = strokeParams.current;

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
          brushCenterUv: { value: mousePos || new THREE.Vector2(-1, -1) },
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
          sourceOffsetX: { value: sourceOffsetUv.x },
          sourceOffsetY: { value: sourceOffsetUv.y },
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
              ? currentReadFBO // Same file: use our own current modified FBO
              : textures.packed; // Different file: use their current modified FBO

        // Override the source texture in commonUniforms to use the correct source
        commonUniforms.sourceSpectrogramTex.value = sourceFbo.texture;

        // Create the uniform set for iterative passes (j > 0).
        // This tells the shader to interpret the input texture using the destination's metadata.
        // For iterative passes, there's no offset since we're reading from our own coordinate space
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
          sourceOffsetX: { value: 0 },
          sourceOffsetY: { value: 0 },
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

          // Mark FBO data cache as dirty since we've modified the buffer
          fboDataDirty.current = true;
        }

        applyStroke.current = false;
      }

      // Update display material uniforms (once per frame at the end)
      const currentFBO = pingPong.current === 0 ? fbo1 : fbo2;
      const nextFBO = pingPong.current === 0 ? fbo2 : fbo1;
      const displayTexture = displayMode.current === "committed" ? currentFBO.texture : nextFBO.texture;

      displayMaterial.uniforms.sourceSpectrogramTex.value = displayTexture;
      displayMaterial.uniforms.sourceInverseMapTex.value = inverseMapTex;
      displayMaterial.uniforms.sourceMetadataTex.value = metadataTex;
      displayMaterial.uniforms.sourceMinFreq.value = spectrogramData.minFreq;
      displayMaterial.uniforms.sourceBandsPerOctave.value = spectrogramData.bandsPerOctave;
      displayMaterial.uniforms.sourceFrameCount.value = spectrogramData.numFrames;
      displayMaterial.uniforms.sourceBandCount.value = spectrogramData.numBands;
      displayMaterial.uniforms.sourceChannelCount.value = spectrogramData.numChannels;
      displayMaterial.uniforms.sourceSampleRate.value = spectrogramData.sampleRate;
      displayMaterial.uniforms.sourceSpectrogramTextureSize.value = spectrogramData.packedTextureSize;
      displayMaterial.uniforms.gridSize.value = state.gridSizeBeats.value;
      displayMaterial.uniforms.bpm.value = bpm;
      displayMaterial.uniforms.brushCenterUv.value = mousePos || new THREE.Vector2(0, 0);
      displayMaterial.uniforms.brushSizeUv.value = brushSizeUv;
      displayMaterial.uniforms.showTargetRectangle.value = isMouseOver;
      displayMaterial.uniforms.showSourceRectangle.value = isSourceFile && isMouseOverAnyFile;

      // Calculate and update grid values
      const gridSizeBeats = state.gridSizeBeats.value;
      const gridSizeSemis = state.gridSizeSemis.value;

      // Horizontal grid (time/beats)
      const beatDurationSeconds = 60.0 / bpm;
      const gridIntervalSeconds = beatDurationSeconds * gridSizeBeats;
      const gridWidthUv = gridSizeBeats > 0 ? gridIntervalSeconds / totalDuration : 0;
      const barWidthUv = gridSizeBeats > 0 ? (beatDurationSeconds * 4.0) / totalDuration : 0;

      // Vertical grid (frequency/semitones)
      const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
      const gridIntervalBands = gridSizeSemis * bandsPerSemitone;
      const gridHeightUv = gridSizeSemis > 0 ? gridIntervalBands / spectrogramData.numBands : 0;

      // Determine if grid lines should be shown based on spacing (min 10 pixels apart)
      const MIN_GRID_SPACING_PX = 10;
      const viewportWidth = gl.domElement.width;
      const viewportHeight = gl.domElement.height;
      const gridWidthPx = gridWidthUv * viewportWidth;
      const gridHeightPx = gridHeightUv * viewportHeight;

      displayMaterial.uniforms.gridWidthUv.value = gridWidthUv;
      displayMaterial.uniforms.gridHeightUv.value = gridHeightUv;
      displayMaterial.uniforms.barWidthUv.value = barWidthUv;
      displayMaterial.uniforms.showHorizontalGrid.value = gridWidthPx >= MIN_GRID_SPACING_PX && gridSizeBeats > 0;
      displayMaterial.uniforms.showVerticalGrid.value = gridHeightPx >= MIN_GRID_SPACING_PX && gridSizeSemis > 0;

      // Update source offset for display (so source rectangle shows correctly)
      if (state.sourceFile?.path) {
        const sourceFileData = openFiles[state.sourceFile.path];
        if (sourceFileData) {
          const sourceBpm = state.filesBpm[state.sourceFile.path] || 120;
          const sourceTotalDuration =
            sourceFileData.spectrogramData.numFrames / sourceFileData.spectrogramData.sampleRate;

          const sourceOffsetUv = calculateSourceOffset(
            state,
            mousePos,
            sourceBpm,
            sourceTotalDuration,
            sourceFileData.spectrogramData,
            bpm,
            totalDuration,
          );

          displayMaterial.uniforms.sourceOffsetX.value = sourceOffsetUv.x;
          displayMaterial.uniforms.sourceOffsetY.value = sourceOffsetUv.y;
        }
      }
    });

    /**
     * Reads the pixel data from the current FBO asynchronously using WebGL2 PBO.
     * Results are cached to avoid redundant GPU readbacks until the data changes.
     */
    const getFBOData = async (): Promise<Float32Array> => {
      // Return cached data if available and not dirty
      if (fboDataCache.current && !fboDataDirty.current) {
        console.log("getFBOData: returning cached data");
        return fboDataCache.current;
      }

      const { packedTextureSize } = spectrogramData;
      const fboToRead = pingPong.current === 0 ? fbo1 : fbo2;
      const data = await readRenderTargetPixelsAsync(
        glRef.current,
        fboToRead,
        0,
        0,
        packedTextureSize.x,
        packedTextureSize.y,
      );

      // Cache the result and mark as clean
      fboDataCache.current = data;
      fboDataDirty.current = false;

      return data;
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

      glRef.current.initTexture(dataTex);

      fboMesh.material = copyMaterial;
      copyMaterial.uniforms.inputTex.value = dataTex;

      glRef.current.setRenderTarget(fbo1);
      glRef.current.render(fboScene, cameraRef.current);
      glRef.current.setRenderTarget(null);

      dataTex.dispose();

      applyStroke.current = false;
      displayMode.current = "committed";

      // Invalidate cache since FBO data has changed
      fboDataDirty.current = true;

      invalidateRef.current();
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

      // Invalidate cache since FBO data will be reset
      fboDataDirty.current = true;

      invalidateRef.current();
      runSynthesis(filePath);
    };

    /**
     * Reloads all textures from the current spectrogramData.
     * Used when the file is re-analyzed with different parameters.
     */
    const reloadTextures = () => {
      const { packedData, inverseMap, metadata, textureWidth, textureHeight, numBands } = spectrogramData;

      // Dispose old textures
      if (packedDataTex) packedDataTex.dispose();
      if (originalPackedDataTex) originalPackedDataTex.dispose();
      if (inverseMapTex) inverseMapTex.dispose();
      if (metadataTex) metadataTex.dispose();

      // Create new textures
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

      // Reset render tracking
      isInitialized.current = false;
      pingPong.current = 0;

      // Invalidate cache since textures have been reloaded
      fboDataDirty.current = true;

      invalidateRef.current();
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
        invalidateRef.current();
      },
      getFBOData,
      setFBOData,
      getTextures,
      restoreOriginal,
      clearPreview,
      reloadTextures,
    }));

    if (!spectrogramData) {
      return null;
    }

    /**
     * Clears the stroke preview from the display.
     */
    const clearPreview = () => {
      displayMode.current = "committed";
      invalidateRef.current();
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
