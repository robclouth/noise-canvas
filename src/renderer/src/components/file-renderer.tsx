import { openFiles, useStore } from "@/store";
import { useFBO } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { runSynthesis } from "@renderer/audio-manager";
import { debounce } from "lodash-es";
import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { brushes } from "../brushes";
import { CommonUniforms, unitsToUv } from "../brushes/common";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { copyMaterial } from "./copy-material";
import { DisplayMaterial } from "./display-material";

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

    const modulatorScaleLut = useModulatorScaleLut();

    // Textures for spectrogram data
    const [packedDataTex, setPackedDataTex] = useState<THREE.DataTexture | null>(null);
    const [originalPackedDataTex, setOriginalPackedDataTex] = useState<THREE.DataTexture | null>(null);
    const [inverseMapTex, setInverseMapTex] = useState<THREE.DataTexture | null>(null);
    const [metadataTex, setMetadataTex] = useState<THREE.DataTexture | null>(null);

    // Interaction state
    const mouseUv = useRef<THREE.Vector2 | null>(null);
    const displayMode = useRef<"preview" | "committed">("committed");
    const applyStroke = useRef(false);

    console.log("file renderer");

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
    const displayMaterial = useMemo(() => new DisplayMaterial(), []);

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

      // Initial copy of the spectrogram data to the FBO
      if (!isInitialized.current) {
        fboMesh.material = copyMaterial;
        copyMaterial.uniforms.inputTex.value = packedDataTex;

        gl.setRenderTarget(fbo1);
        gl.render(fboScene, camera);
        gl.setRenderTarget(null);

        isInitialized.current = true;
        pingPong.current = 0;

        invalidate();

        window.api.addUndoState({ data: spectrogramData.packedData.buffer, filePath });
        debouncedSynthesis(filePath, spectrogramData.packedData);
      }
      const state = useStore.getState();

      const sourceFile = state.sourceFilePath ? openFiles[state.sourceFilePath] : null;
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
        sourceSpectrogramTex: textures.packed.texture,
        sourceSpectrogramTextureSize: sourceFile.spectrogramData.packedTextureSize,
        sourceInverseMapTex: textures.inverse,
        sourceMetadataTex: textures.metadata,
        sourceMinFreq: sourceFile.spectrogramData.minFreq,
        sourceBandsPerOctave: sourceFile.spectrogramData.bandsPerOctave,
        sourceFrameCount: sourceFile.spectrogramData.numFrames,
        sourceBandCount: sourceFile.spectrogramData.numBands,
        sourceChannelCount: sourceFile.spectrogramData.numChannels,
        sourceSampleRate: sourceFile.spectrogramData.sampleRate,
        destSpectrogramTex: currentReadFBO.texture,
        destSpectrogramTextureSize: spectrogramData.packedTextureSize,
        destInverseMapTex: inverseMapTex,
        destMetadataTex: metadataTex,
        destMinFreq: spectrogramData.minFreq,
        destBandsPerOctave: spectrogramData.bandsPerOctave,
        destFrameCount: spectrogramData.numFrames,
        destBandCount: spectrogramData.numBands,
        destChannelCount: spectrogramData.numChannels,
        destSampleRate: spectrogramData.sampleRate,
        originalSpectrogramTex: originalPackedDataTex,
        viewZoomPower: state.zoomPower.value,
        viewOffset: state.scroll.value,
        brushCenterUv: mouseUv.current || new THREE.Vector2(-1, -1),
        brushSizeUv,
        featherX: state.featherTime.value / 100,
        featherY: state.featherPitch.value / 100,
        brushIntensity: {
          value: state.brushIntensity.value / 100,
          minValue: state.brushIntensity.min / 100,
          maxValue: state.brushIntensity.max / 100,
          modulationAmount: state.brushIntensityMod.value / 100,
        },
        brushPan: {
          value: state.brushPan.value / 100,
          minValue: state.brushPan.min / 100,
          maxValue: state.brushPan.max / 100,
          modulationAmount: state.brushPanMod.value / 100,
        },
        bpm,
        sourceOffsetX: {
          value: sourceOffsetUv.x,
          minValue: 0.0,
          maxValue: 1.0,
          modulationAmount: state.sourceOffsetBeatsMod.value / 100,
        },
        sourceOffsetY: {
          value: sourceOffsetUv.y,
          minValue: 0.0,
          maxValue: 1.0,
          modulationAmount: state.sourceOffsetSemisMod.value / 100,
        },
        blendMode: state.blendMode.value,
        modulatorMode: state.modulatorMode.value,
        modulatorPatternShape: state.modulatorPatternShape.value,
        modulatorPatternRate: unitsToUv(
          state.modulatorPatternRateBeats.value,
          state.modulatorPatternRateSemis.value,
          bpm,
          totalDuration,
          spectrogramData.bandsPerOctave,
          spectrogramData.numBands,
        ),
        modulatorPatternRadial: state.modulatorPatternRadial.value,
        modulatorStrength: state.modulatorStrength.value / 100,
        modulatorRotation: state.modulatorRotation.value,
        gainLut: modulatorScaleLut || new THREE.Texture(),
      };

      console.log("use frame");

      // Render brush stroke if requested
      if (strokeParams.current && applyStroke.current) {
        const sourceFbo = textures.packed; // The original, unmodified source FBO
        const destinationFbo = pingPong.current === 0 ? fbo2 : fbo1;
        const { preview } = strokeParams.current;

        const brush = brushes[state.brushType.value];
        const numPasses = brush.materials.length;

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

        for (let j = 0; j < state.brushIterations.value; j++) {
          const uniformsForThisIteration = j === 0 ? commonUniforms : iterativeUniforms;

          for (let i = 0; i < numPasses; i++) {
            const material = brush.materials[i];
            fboMesh.material = material;

            const isFinalPass = j === state.brushIterations.value - 1 && i === numPasses - 1;
            const currentWriteFbo = isFinalPass ? destinationFbo : tempFboA;

            const inputTexture = currentReadFbo.texture;

            // The "source" is always the result of the previous pass.
            uniformsForThisIteration.sourceSpectrogramTex = inputTexture;

            // The "destination" (for blending) is the original target on the first pass.
            // For all subsequent iterative passes, the destination is the source (self-modification).
            uniformsForThisIteration.destSpectrogramTex = j === 0 ? commonUniforms.destSpectrogramTex : inputTexture;

            brush.updateBrushUniforms({ commonUniforms: uniformsForThisIteration, passIndex: i, file: sourceFile });

            gl.setRenderTarget(currentWriteFbo);
            gl.render(fboScene, camera);

            currentReadFbo = currentWriteFbo;

            if (!isFinalPass) {
              [tempFboA, tempFboB] = [tempFboB, tempFboA];
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
        sourceSpectrogramTex: displayMode.current === "committed" ? currentFBO.texture : nextFBO.texture,
        sourceInverseMapTex: inverseMapTex,
        sourceMetadataTex: metadataTex,
        sourceMinFreq: spectrogramData.minFreq,
        sourceBandsPerOctave: spectrogramData.bandsPerOctave,
        sourceFrameCount: spectrogramData.numFrames,
        sourceBandCount: spectrogramData.numBands,
        sourceChannelCount: spectrogramData.numChannels,
        sourceSampleRate: spectrogramData.sampleRate,
        sourceSpectrogramTextureSize: spectrogramData.packedTextureSize,
        gridSize: state.gridSizeBeats.value,
        bpm,
        isSourceFile: sourceFile?.filePath === filePath,
        isTargetFile: state.activeFilePath === filePath,
      };

      for (const [key, value] of Object.entries(displayUniforms)) {
        if (displayMaterial.uniforms[key]) {
          displayMaterial.uniforms[key].value = value;
        }
      }

      if (applyStroke.current) applyStroke.current = false;
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
    } | null => {
      if (!fbo1 || !fbo2 || !inverseMapTex || !metadataTex) return null;
      return {
        packed: pingPong.current === 0 ? fbo1 : fbo2,
        inverse: inverseMapTex,
        metadata: metadataTex,
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
