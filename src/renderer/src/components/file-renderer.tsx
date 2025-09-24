import {
  activeFileAtom,
  blendModeAtom,
  brushHeightAtom,
  brushIntensityAtom,
  brushIntensityModAtom,
  brushTypeAtom,
  brushWidthAtom,
  featherXAtom,
  featherYAtom,
  filesBpmAtom,
  gridSizeAtom,
  modulatorModeAtom,
  modulatorPatternRadialAtom,
  modulatorPatternRateBeatsAtom,
  modulatorPatternRateCentsAtom,
  modulatorPatternShapeAtom,
  mousePosAtom,
  offsetXAtom,
  offsetYAtom,
  panAtom,
  rendererRefs,
  scrollAtom,
  sourceFileAtom,
  store,
  zoomPowerAtom,
} from "@/store";
import { useFBO } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { isSynthesizingAtom, runSynthesis } from "@renderer/audio-manager";
import type { OpenFile } from "@renderer/types";
import { debounce } from "lodash-es";
import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { brushes } from "./brushes";
import { CommonUniforms, unitsToUv } from "./brushes/common";
import { copyMaterial } from "./copy-material";
import { DisplayMaterial } from "./display-material";

/**
 * Props for the FileRenderer component.
 * @param file - The open file to render.
 */
interface FileRendererProps {
  file: OpenFile;
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

const blendModeMap = {
  Normal: 0,
  Maximum: 1,
  Minimum: 2,
  Dissolve: 3,
  Multiply: 4,
  Difference: 5,
  Subtract: 6,
  Divide: 7,
};

/**
 * The `FileRenderer` component is responsible for rendering the spectrogram of an audio file
 * and handling real-time brush interactions for editing the spectrogram data.
 * It uses `react-three-fiber` for rendering and manages textures and frame buffer objects (FBOs)
 * for processing and displaying the spectrogram.
 */
export const FileRenderer = memo(
  forwardRef<FileRendererHandle, FileRendererProps>(({ file }, ref) => {
    const { spectrogramData } = file;
    const { gl, camera, invalidate } = useThree();

    // Component state and refs
    const [sourceFile, setSourceFile] = useState(() => store.get(sourceFileAtom));
    const [activeFile, setActiveFile] = useState(() => store.get(activeFileAtom));

    // Textures for spectrogram data
    const [packedDataTex, setPackedDataTex] = useState<THREE.DataTexture | null>(null);
    const [originalPackedDataTex, setOriginalPackedDataTex] = useState<THREE.DataTexture | null>(null);
    const [inverseMapTex, setInverseMapTex] = useState<THREE.DataTexture | null>(null);
    const [metadataTex, setMetadataTex] = useState<THREE.DataTexture | null>(null);

    const sourceFileData = useRef<{
      packed?: THREE.DataTexture;
      meta?: THREE.DataTexture;
    }>({});

    // Interaction state
    const mouseUv = useRef<THREE.Vector2 | null>(null);
    const displayMode = useRef<"preview" | "committed">("committed");
    const applyStroke = useRef(false);

    // Subscriptions to global state
    useEffect(() => {
      const unsubMouseUv = store.sub(mousePosAtom, () => {
        mouseUv.current = store.get(mousePosAtom);
      });
      const unsubBpms = store.sub(filesBpmAtom, () => {
        invalidate();
      });
      const unsubSourceFile = store.sub(sourceFileAtom, () => {
        setSourceFile(store.get(sourceFileAtom));
      });
      const unsubActiveFile = store.sub(activeFileAtom, () => {
        setActiveFile(store.get(activeFileAtom));
      });
      return () => {
        unsubMouseUv();
        unsubBpms();
        unsubSourceFile();
        unsubActiveFile();
      };
    }, [invalidate]);

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

    const passFbo = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });

    // Rendering state
    const pingPong = useRef(0);
    const isInitialized = useRef(false);

    const strokeParams = useRef<{ x: number; y: number; preview: boolean } | null>(null);

    // Effect to create textures for the source file when it changes
    useEffect(() => {
      if (sourceFile && sourceFile.filePath !== file.filePath) {
        const { packedData, metadata, textureWidth, textureHeight, numBands } = sourceFile.spectrogramData;
        const packed = new THREE.DataTexture(
          packedData,
          textureWidth,
          textureHeight,
          THREE.RGBAFormat,
          THREE.FloatType,
        );
        packed.internalFormat = "RGBA32F";
        packed.minFilter = THREE.NearestFilter;
        packed.magFilter = THREE.NearestFilter;
        packed.needsUpdate = true;
        const meta = new THREE.DataTexture(metadata, numBands, 1, THREE.RGBFormat, THREE.FloatType);
        meta.internalFormat = "RGB32F";
        meta.minFilter = THREE.NearestFilter;
        meta.magFilter = THREE.NearestFilter;
        meta.needsUpdate = true;
        sourceFileData.current = { packed, meta };
      } else {
        sourceFileData.current = {};
      }

      return () => {
        sourceFileData.current.packed?.dispose();
        sourceFileData.current.meta?.dispose();
      };
    }, [sourceFile, file.filePath]);

    useEffect(() => {
      isInitialized.current = false;
      invalidate(); // Request a render to trigger the initialization in useFrame
    }, [file.filePath, invalidate]);

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
      if (!fboMesh || !spectrogramData || !packedDataTex || !inverseMapTex || !metadataTex || !fbo1 || !fbo2) return;

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

        window.api.addUndoState({ data: spectrogramData.packedData.buffer, filePath: file.filePath });
        debouncedSynthesis(file, spectrogramData.packedData);
      }

      if (!sourceFile) return;

      // Get current brush and view parameters from the global store
      const brushType = store.get(brushTypeAtom);
      const gridSize = store.get(gridSizeAtom);
      const zoomPower = store.get(zoomPowerAtom);
      const scroll = store.get(scrollAtom);
      const pan = store.get(panAtom);
      const brushIntensity = store.get(brushIntensityAtom);
      const brushIntensityMod = store.get(brushIntensityModAtom);
      const offsetX = store.get(offsetXAtom);
      const offsetY = store.get(offsetYAtom);
      const featherX = store.get(featherXAtom);
      const featherY = store.get(featherYAtom);
      const brushWidth = store.get(brushWidthAtom);
      const brushHeight = store.get(brushHeightAtom);
      const blendMode = store.get(blendModeAtom);
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const sourceTotalDuration = sourceFile.spectrogramData.numFrames / sourceFile.spectrogramData.sampleRate;

      const modulatorMode = store.get(modulatorModeAtom);
      const modulatorPatternShape = store.get(modulatorPatternShapeAtom);
      const modulatorPatternRateBeats = store.get(modulatorPatternRateBeatsAtom);
      const modulatorPatternRateCents = store.get(modulatorPatternRateCentsAtom);
      const modulatorPatternRadial = store.get(modulatorPatternRadialAtom);

      const sourceRendererRef = rendererRefs[sourceFile.filePath];

      const textures = sourceRendererRef?.current?.getTextures();
      if (!textures) return;

      // Determine the current FBO for reading
      const currentReadFBO = pingPong.current === 0 ? fbo1 : fbo2;
      const bpms = store.get(filesBpmAtom);
      const bpm = bpms[file.filePath] || 120;
      const sourceBpm = bpms[sourceFile.filePath] || 120;

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
        viewZoomPower: zoomPower,
        viewOffset: scroll,
        brushCenterUv: mouseUv.current || new THREE.Vector2(-1, -1),
        brushSizeUv: mouseUv.current
          ? unitsToUv(
              brushWidth,
              brushHeight,
              bpm,
              totalDuration,
              spectrogramData.bandsPerOctave,
              spectrogramData.numBands,
            )
          : new THREE.Vector2(0, 0),
        featherX: featherX / 100,
        featherY: featherY / 100,
        brushIntensity: brushIntensity / 100,
        brushIntensityMod: brushIntensityMod / 100,
        pan,
        bpm,
        offsetUv: unitsToUv(
          offsetX,
          offsetY,
          sourceBpm,
          sourceTotalDuration,
          sourceFile.spectrogramData.bandsPerOctave,
          sourceFile.spectrogramData.numBands,
        ),
        blendMode: blendModeMap[blendMode],
        modulatorMode,
        modulatorPatternShape,
        modulatorPatternRateBeats,
        modulatorPatternRateCents,
        modulatorPatternRadial,
      };

      // Render brush stroke if requested
      if (strokeParams.current && applyStroke.current) {
        const source = textures.packed;

        const destination = pingPong.current === 0 ? fbo2 : fbo1;
        const { preview } = strokeParams.current;

        const brush = brushes[brushType];
        const numPasses = brush.materials.length;

        let readBuffer = source;
        let writeBuffer = passFbo;

        // Multi-pass rendering for complex brushes
        for (let i = 0; i < numPasses; i++) {
          const material = brush.materials[i];
          fboMesh.material = material;

          // The final pass always writes to the main destination buffer.
          // For a single-pass effect, this is met on the first iteration.
          if (i === numPasses - 1) {
            writeBuffer = destination;
          }

          commonUniforms.sourceSpectrogramTex = readBuffer.texture;
          brush.updateUniforms(commonUniforms, i);

          gl.setRenderTarget(writeBuffer);
          gl.render(fboScene, camera);

          // Swap buffers for the next pass
          [readBuffer, writeBuffer] = [writeBuffer, readBuffer];
        }

        gl.setRenderTarget(null);

        // If the stroke is not a preview, commit the changes
        if (!preview) {
          pingPong.current = 1 - pingPong.current;
          displayMode.current = "committed";

          store.set(isSynthesizingAtom, true);
          const buffer = getFBOData();
          debouncedSynthesis(file, buffer);
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
        gridSize: gridSize,
        bpm: bpm,
        isSourceFile: sourceFile?.filePath === file.filePath,
        isTargetFile: activeFile?.filePath === file.filePath,
      };

      displayUniforms.bpm = bpm;

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
      debouncedSynthesis(file, getFBOData());
    };

    /**
     * Triggers audio synthesis for the current state of the spectrogram.
     */
    const synthesize = () => {
      store.set(isSynthesizingAtom, true);
      const buffer = getFBOData();
      debouncedSynthesis(file, buffer);
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
