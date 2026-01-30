import { createStepStateView, useStore } from "@/store";
import { useFrame } from "@react-three/fiber";
import { EffectType } from "@renderer/effects";
import { CommonUniforms, defaultValues } from "@renderer/effects/base-effect";
import { openFiles } from "@renderer/store/files";
import { getContextualModAmountsNormalized, getModAmountValuesNormalized } from "@renderer/store/modulators";
import { State } from "@renderer/store/types";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createNoise2D } from "simplex-noise";
import {
  Camera,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  PlaneGeometry,
  RawShaderMaterial,
  RedFormat,
  RGBAFormat,
  RGFormat,
  Scene,
  Texture,
  UniformsUtils,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { effects } from "../effects";
import displayFrag from "../glsl/display.frag";
import maskUpdateFrag from "../glsl/mask-update.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { readRenderTargetPixelsAsync } from "../lib/async-readpixels";
import { buildModulatorUniforms, useModulatorScaleLut } from "../lib/modulator-utils";
import { withPlatformDefines } from "../lib/shader-utils";
import { useModulatorTexture, usePlaceholderTexture } from "../lib/textures";
import { getUndoManager } from "../lib/undo-manager";
import { unitsToUv } from "../lib/utils";
import { copyMaterial } from "./copy-material";

const noise2D = createNoise2D();

// Helper function to calculate normalized envelope stage boundaries
// Returns absolute UV values for each stage
function calculateEnvelopeBoundaries(
  delay: number,
  attack: number,
  sustain: number,
  release: number,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
  isTime: boolean,
): {
  d: number;
  a: number;
  s: number;
  r: number;
  delayEnd: number;
  attackEnd: number;
  sustainEnd: number;
  releaseEnd: number;
} {
  let d: number, a: number, s: number, r: number;

  // Convert from beats/semitones to absolute UV using unitsToUv
  if (isTime) {
    d = unitsToUv(delay, 0, bpm, totalDuration, bandsPerOctave, numBands).x;
    a = unitsToUv(attack, 0, bpm, totalDuration, bandsPerOctave, numBands).x;
    s = unitsToUv(sustain, 0, bpm, totalDuration, bandsPerOctave, numBands).x;
    r = unitsToUv(release, 0, bpm, totalDuration, bandsPerOctave, numBands).x;
  } else {
    d = unitsToUv(0, delay, bpm, totalDuration, bandsPerOctave, numBands).y;
    a = unitsToUv(0, attack, bpm, totalDuration, bandsPerOctave, numBands).y;
    s = unitsToUv(0, sustain, bpm, totalDuration, bandsPerOctave, numBands).y;
    r = unitsToUv(0, release, bpm, totalDuration, bandsPerOctave, numBands).y;
  }

  // Calculate total brush size from envelope
  const brushSize = d + a + s + r;

  // Calculate cumulative positions as fractions of brush size (normalized 0-1)
  const safeSize = Math.max(brushSize, 0.0001);
  return {
    d,
    a,
    s,
    r,
    delayEnd: d / safeSize,
    attackEnd: (d + a) / safeSize,
    sustainEnd: (d + a + s) / safeSize,
    releaseEnd: (d + a + s + r) / safeSize,
  };
}

/**
 * Props for the FileRenderer component.
 * @param file - The open file to render.
 */
interface FileRendererProps {
  fileId: string;
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
    packed: WebGLRenderTarget;
    inverse: DataTexture;
    metadata: DataTexture;
    original: DataTexture;
  } | null;
  /** Restores the spectrogram to its original state. */
  restoreOriginal: () => void;
  /** Clears the stroke preview. */
  clearPreview: () => void;
  /** Reloads all textures from the current spectrogramData (used after re-analysis). */
  reloadTextures: () => void;
  applyStroke: () => void;
  beginStroke: () => void;
  endStroke: () => void;
}

/**
 * The `FileRenderer` component is responsible for rendering the spectrogram of an audio file
 * and handling real-time brush interactions for editing the spectrogram data.
 * It uses `react-three-fiber` for rendering and manages textures and frame buffer objects (FBOs)
 * for processing and displaying the spectrogram.
 */
export const FileRenderer = memo(
  forwardRef<FileRendererHandle, FileRendererProps>(({ fileId }, ref) => {
    const { spectrogramData } = openFiles[fileId];

    // Don't subscribe to these during render - access them via refs or useFrame instead
    const glRef = useRef<WebGLRenderer>(null!);
    const cameraRef = useRef<Camera>(null!);
    const invalidateRef = useRef<() => void>(null!);

    const modulatorScaleLut = useModulatorScaleLut(fileId);

    // Load image textures for all modulators
    const modulator1Texture = useModulatorTexture(0);
    const modulator2Texture = useModulatorTexture(1);
    const modulator3Texture = useModulatorTexture(2);

    // Textures for spectrogram data
    const [packedDataTex, setPackedDataTex] = useState<DataTexture | null>(null);
    const [originalPackedDataTex, setOriginalPackedDataTex] = useState<DataTexture | null>(null);
    const [inverseMapTex, setInverseMapTex] = useState<DataTexture | null>(null);
    const [metadataTex, setMetadataTex] = useState<DataTexture | null>(null);

    // Interaction state
    const displayMode = useRef<"preview" | "committed">("committed");
    const applyStroke = useRef(false);
    const clearingPreview = useRef(false);

    console.log("FileRenderer rendered");

    // Subscriptions to global state
    useEffect(() => {
      const unsubBpms = useStore.subscribe(
        (state) => {
          const file = openFiles[fileId];
          return file && state.filepathsBpm[file.filePath];
        },
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubZoom = useStore.subscribe(
        (state) => state.filesZoom[fileId],
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubOffset = useStore.subscribe(
        (state) => state.filesOffset[fileId],
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubGridBeats = useStore.subscribe(
        (state) => state.gridSizeBeats,
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubGridSemis = useStore.subscribe(
        (state) => state.gridSizeSemis,
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubDisplayMinDb = useStore.subscribe(
        (state) => state.displayMinDb,
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubDisplayMaxDb = useStore.subscribe(
        (state) => state.displayMaxDb,
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubCursorPosition = useStore.subscribe(
        (state) => state.cursorPosition,
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubCursorVisible = useStore.subscribe(
        (state) => state.cursorVisible,
        () => {
          invalidateRef.current?.();
        },
      );
      const unsubActiveFileId = useStore.subscribe(
        (state) => state.activeFileId,
        (activeId) => {
          if (activeId !== fileId) {
            // Became inactive: clear any preview
            clearPreview();
          } else {
            // Became active: if cursor is visible, trigger a preview render
            // We need to wait for the state update to propagate
            const state = useStore.getState();
            const currentFile = openFiles[fileId];
            if (state.cursorVisible && state.cursorPosition && currentFile) {
              const bpm = state.filepathsBpm[currentFile.filePath] || 120;
              const totalDuration = currentFile.spectrogramData.numFrames / currentFile.spectrogramData.sampleRate;
              const uvPos = unitsToUv(
                state.cursorPosition.beats,
                state.cursorPosition.pitch,
                bpm,
                totalDuration,
                spectrogramData.bandsPerOctave,
                spectrogramData.numBands,
              );

              // Simulate renderStroke
              strokeParams.current = { x: uvPos.x, y: uvPos.y, preview: true };
              displayMode.current = "preview";
              applyStroke.current = true;
              invalidateRef.current?.();
            } else {
              invalidateRef.current?.();
            }
          }
        },
      );

      return () => {
        unsubBpms();
        unsubZoom();
        unsubOffset();
        unsubGridBeats();
        unsubGridSemis();
        unsubDisplayMinDb();
        unsubDisplayMaxDb();
        unsubCursorPosition();
        unsubCursorVisible();
        unsubActiveFileId();
      };
    }, [fileId]);

    // Materials and scene objects for rendering
    const displayMaterial = useMemo(() => {
      const state = useStore.getState();
      return new RawShaderMaterial({
        uniforms: {
          ...UniformsUtils.clone(defaultValues),
          sourceBrushSizeUv: { value: new Vector2(0.1, 0.1) },
          minDb: { value: state.displayMinDb },
          maxDb: { value: state.displayMaxDb },
          bpm: { value: 120.0 },
          gridSize: { value: 0.25 },
          gridWidthUv: { value: 0.0 },
          gridHeightUv: { value: 0.0 },
          barWidthUv: { value: 0.0 },
          showHorizontalGrid: { value: true },
          showVerticalGrid: { value: true },
          showTargetRectangle: { value: false },
          showSourceRectangle: { value: false },
          viewZoomPower: { value: 0.0 },
          viewOffset: { value: 0.0 },
          wrapMode: { value: 0 },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(displayFrag),
        glslVersion: GLSL3,
      });
    }, []);

    const maskMaterial = useMemo(() => {
      return new RawShaderMaterial({
        uniforms: {
          ...UniformsUtils.clone(defaultValues),
          currentMaskTex: { value: null },
          destMetadataTex: { value: null },
          destInverseMapTex: { value: null },
          destSpectrogramTextureSize: { value: new Vector2(1, 1) },
          destFrameCount: { value: 0 },
          destBandCount: { value: 0 },
          brushBottomLeftUv: { value: new Vector2(0, 0) },
          brushSizeUv: { value: new Vector2(0, 0) },
          envelopeDelayEndX: { value: 0 },
          envelopeAttackEndX: { value: 0 },
          envelopeSustainEndX: { value: 0 },
          envelopeReleaseEndX: { value: 0 },
          envelopeDelayEndY: { value: 0 },
          envelopeAttackEndY: { value: 0 },
          envelopeSustainEndY: { value: 0 },
          envelopeReleaseEndY: { value: 0 },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(maskUpdateFrag),
        glslVersion: GLSL3,
      });
    }, []);

    const mesh = useRef<Mesh>(null!);
    const { scene: fboScene, mesh: fboMesh } = useMemo(() => {
      const scene = new Scene();
      const mesh = new Mesh(new PlaneGeometry(2, 2));
      scene.add(mesh);
      return { scene, mesh };
    }, []);

    // Frame Buffer Objects for ping-pong rendering
    // Create FBOs manually to avoid useFBO's internal canvas size subscriptions
    const fbo1 = useMemo(() => {
      const fbo = new WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: RGBAFormat,
        type: FloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
      });
      return fbo;
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    const fbo2 = useMemo(() => {
      const fbo = new WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: RGBAFormat,
        type: FloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
      });
      return fbo;
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    const passFbo1 = useMemo(() => {
      const fbo = new WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: RGBAFormat,
        type: FloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
      });
      return fbo;
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    const passFbo2 = useMemo(() => {
      const fbo = new WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: RGBAFormat,
        type: FloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
      });
      return fbo;
      return fbo;
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    // Stroke Mask FBO
    const strokeMaskFbo = useMemo(() => {
      const fbo = new WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: RedFormat,
        type: FloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
      });
      return fbo;
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    // Second Stroke Mask FBO for ping-pong rendering
    const strokeMaskFbo2 = useMemo(() => {
      const fbo = new WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: RedFormat,
        type: FloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
      });
      return fbo;
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

    // Stroke Start FBO (Snapshot of canvas at start of stroke)
    const strokeStartFbo = useMemo(() => {
      const fbo = new WebGLRenderTarget(spectrogramData.textureWidth, spectrogramData.textureHeight, {
        format: RGBAFormat,
        type: FloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
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
        strokeMaskFbo.dispose();
        strokeMaskFbo2.dispose();
        strokeStartFbo.dispose();
      };
    }, [fbo1, fbo2, passFbo1, passFbo2, strokeMaskFbo, strokeMaskFbo2, strokeStartFbo]);

    // Rendering state
    const pingPong = useRef(0);
    const maskPingPong = useRef(0);
    const isInitialized = useRef(false);

    const strokeParams = useRef<{ x: number; y: number; preview: boolean } | null>(null);

    // FBO data cache to avoid redundant GPU readbacks
    const fboDataCache = useRef<Float32Array | null>(null);
    const fboDataDirty = useRef(true);

    /**
     * Helper to snapshot the current FBO state to the strokeStartFbo.
     * This ensures that when a new stroke starts (especially in Single Stroke mode),
     * we have a clean copy of the "before" state to use as a source.
     */
    const snapshotToStrokeStart = useCallback(
      (sourceTexture: Texture) => {
        const gl = glRef.current;
        if (!fboMesh || !strokeStartFbo || !gl || !copyMaterial) return;

        // Save previous material
        const prevMaterial = fboMesh.material;

        fboMesh.material = copyMaterial;
        copyMaterial.uniforms.inputTex.value = sourceTexture;

        const oldTarget = gl.getRenderTarget();
        gl.setRenderTarget(strokeStartFbo);
        gl.render(fboScene, cameraRef.current);
        gl.setRenderTarget(oldTarget);

        // Restore material (though usually it's reset elsewhere, good safety)
        fboMesh.material = prevMaterial;
      },
      [fboMesh, strokeStartFbo, fboScene],
    );

    /**
     * Creates DataTextures from spectrogram data.
     * Used both on initial load and when reloading textures.
     */
    const createTextures = useCallback(() => {
      const { packedData, inverseMap, metadata, textureWidth, textureHeight, numBands } = spectrogramData;

      const packed = new DataTexture(packedData, textureWidth, textureHeight, RGBAFormat, FloatType);
      packed.internalFormat = "RGBA32F";
      packed.minFilter = NearestFilter;
      packed.magFilter = NearestFilter;
      packed.wrapS = ClampToEdgeWrapping;
      packed.wrapT = ClampToEdgeWrapping;
      packed.generateMipmaps = false;
      packed.needsUpdate = true;

      const inverse = new DataTexture(inverseMap, textureWidth, textureHeight, RGFormat, FloatType);
      inverse.internalFormat = "RG32F";
      inverse.minFilter = NearestFilter;
      inverse.magFilter = NearestFilter;
      inverse.wrapS = ClampToEdgeWrapping;
      inverse.wrapT = ClampToEdgeWrapping;
      inverse.generateMipmaps = false;
      inverse.needsUpdate = true;

      const meta = new DataTexture(metadata, numBands, 1, RGBAFormat, FloatType);
      meta.internalFormat = "RGBA32F";
      meta.minFilter = NearestFilter;
      meta.magFilter = NearestFilter;
      meta.wrapS = ClampToEdgeWrapping;
      meta.wrapT = ClampToEdgeWrapping;
      meta.generateMipmaps = false;
      meta.needsUpdate = true;

      return { packed, inverse, meta };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      spectrogramData.packedData,
      spectrogramData.inverseMap,
      spectrogramData.metadata,
      spectrogramData.textureWidth,
      spectrogramData.textureHeight,
      spectrogramData.numBands,
    ]);

    // Effect to create and manage spectrogram textures
    useEffect(() => {
      const { packed, inverse, meta } = createTextures();

      const original = packed.clone();

      original.wrapS = ClampToEdgeWrapping;
      original.wrapT = ClampToEdgeWrapping;
      original.minFilter = NearestFilter;
      original.magFilter = NearestFilter;
      original.generateMipmaps = false;
      original.needsUpdate = true;

      setPackedDataTex(packed);
      setOriginalPackedDataTex(original);
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
    }, [createTextures]);

    /**
     * Helper function to calculate source offset based on position mode.
     * This consolidates the logic used for both stroke rendering and display.
     */
    const calculateSourceOffset = useCallback(
      (
        state: ReturnType<typeof useStore.getState>,
        mousePos: Vector2 | null,
        sourceBpm: number,
        sourceTotalDuration: number,
        sourceSpectrogramData: typeof spectrogramData,
        bpm: number,
        totalDuration: number,
      ): Vector2 => {
        const sourceOffsetUv = new Vector2(0, 0);

        if (!state.sourcePosition || !mousePos) {
          return sourceOffsetUv;
        }

        const mode = state.sourcePositionMode;

        // Calculate brush size from envelope in the CURRENT file's coordinate space
        const envelopeTimeUvCurrent = unitsToUv(
          state.brushEnvelopeDelayTime +
          state.brushEnvelopeAttackTime +
          state.brushEnvelopeSustainTime +
          state.brushEnvelopeReleaseTime,
          0,
          bpm,
          totalDuration,
          spectrogramData.bandsPerOctave,
          spectrogramData.numBands,
        );
        const envelopePitchUvCurrent = unitsToUv(
          0,
          state.brushEnvelopeDelayPitch +
          state.brushEnvelopeAttackPitch +
          state.brushEnvelopeSustainPitch +
          state.brushEnvelopeReleasePitch,
          bpm,
          totalDuration,
          spectrogramData.bandsPerOctave,
          spectrogramData.numBands,
        );
        const brushSizeUvCurrent = new Vector2(envelopeTimeUvCurrent.x || 1, envelopePitchUvCurrent.y || 1);
        const halfBrushSizeUvCurrent = new Vector2(brushSizeUvCurrent.x / 2, brushSizeUvCurrent.y / 2);

        // Convert source position (bottom-left) to UV coordinates in the source file
        const sourcePositionBottomLeftUv = unitsToUv(
          state.sourcePosition.beats,
          state.sourcePosition.pitch,
          sourceBpm,
          sourceTotalDuration,
          sourceSpectrogramData.bandsPerOctave,
          sourceSpectrogramData.numBands,
        );
        const sourcePositionUv = sourcePositionBottomLeftUv.clone();
        const currentBrushUv = mousePos.clone();

        if (mode === "fixed") {
          return sourcePositionUv.clone().sub(currentBrushUv);
        } else if (mode === "anchored") {
          if (state.cursorPosition) {
            const brushStartBottomLeftUv = unitsToUv(
              state.cursorPosition.beats,
              state.cursorPosition.pitch,
              bpm,
              totalDuration,
              spectrogramData.bandsPerOctave,
              spectrogramData.numBands,
            );
            const brushStartUv = brushStartBottomLeftUv.clone();
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
          } else if (state.cursorPosition) {
            const brushStartBottomLeftUv = unitsToUv(
              state.cursorPosition.beats,
              state.cursorPosition.pitch,
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
      },
      [spectrogramData.bandsPerOctave, spectrogramData.numBands],
    );

    const placeholderTexture = usePlaceholderTexture();

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

      const file = openFiles[fileId];
      if (!file) return;

      const bpm = state.filepathsBpm[file.filePath] || 120;
      const totalDuration = file.spectrogramData.numFrames / file.spectrogramData.sampleRate;

      // Determine cursor position in UV
      let cursorPos = new Vector2(-1, -1);

      if ((state.activeFileId === fileId || state.hoveredFile === fileId) && state.cursorPosition) {
        cursorPos = unitsToUv(
          state.cursorPosition.beats,
          state.cursorPosition.pitch,
          bpm,
          totalDuration,
          spectrogramData.bandsPerOctave,
          spectrogramData.numBands,
        );
      }

      // Determine file state for rendering logic
      const isActiveFile = state.activeFileId === fileId;
      const isSourceFile = state.sourceFile === fileId;
      const isMouseOverAnyFile = Boolean(state.cursorVisible && state.cursorPosition && state.hoveredFile);

      // Initial copy of the spectrogram data to the FBO
      if (!isInitialized.current) {
        fboMesh.material = copyMaterial;
        copyMaterial.uniforms.inputTex.value = packedDataTex;

        gl.setRenderTarget(fbo1);
        gl.render(fboScene, camera);
        gl.setRenderTarget(null);

        pingPong.current = 0;

        // Clear both mask FBOs on init
        const oldClearColor = new Color();
        gl.getClearColor(oldClearColor);
        const oldClearAlpha = gl.getClearAlpha();
        gl.setClearColor(0x000000, 0);
        gl.setRenderTarget(strokeMaskFbo);
        gl.clear(true, false, false);
        gl.setRenderTarget(strokeMaskFbo2);
        gl.clear(true, false, false);
        gl.setRenderTarget(null);
        gl.setClearColor(oldClearColor, oldClearAlpha);
        maskPingPong.current = 0;

        // Snapshot initial state to strokeStartFbo
        snapshotToStrokeStart(fbo1.texture);

        // Invalidate cache since FBO has been initialized
        fboDataDirty.current = true;

        state.synthesizeFile(fileId);

        const undoManager = getUndoManager(fileId);
        undoManager.addState(spectrogramData.packedData, fileId);
      }

      // After initialization, only update if this file is active, source, or cursor is present
      if (
        !isActiveFile &&
        !isSourceFile &&
        !(state.cursorVisible && state.cursorPosition) &&
        !clearingPreview.current &&
        isInitialized.current
      ) {
        return;
      }

      isInitialized.current = true;

      clearingPreview.current = false;

      // Get per-file zoom and offset from store
      const viewZoomPower = state.filesZoom[fileId];
      const viewOffset = state.filesOffset[fileId];

      // Helper to calculate brush size from a step state
      const calculateBrushSizeUv = (stepState: State) => {
        const envelopeTimeUv = unitsToUv(
          stepState.brushEnvelopeDelayTime +
          stepState.brushEnvelopeAttackTime +
          stepState.brushEnvelopeSustainTime +
          stepState.brushEnvelopeReleaseTime,
          0,
          bpm,
          totalDuration,
          spectrogramData.bandsPerOctave,
          spectrogramData.numBands,
        );
        const envelopePitchUv = unitsToUv(
          0,
          stepState.brushEnvelopeDelayPitch +
          stepState.brushEnvelopeAttackPitch +
          stepState.brushEnvelopeSustainPitch +
          stepState.brushEnvelopeReleasePitch,
          bpm,
          totalDuration,
          spectrogramData.bandsPerOctave,
          spectrogramData.numBands,
        );
        return new Vector2(envelopeTimeUv.x, envelopePitchUv.y);
      };

      // Helper to build common uniforms for a specific step
      const buildStepUniforms = (
        stepState: State,
        brushSizeUv: Vector2,
        sourceOffsetUv: Vector2,
        destTexture: WebGLRenderTarget | { texture: DataTexture },
      ): CommonUniforms => {
        const sourceFile = openFiles[state.sourceFile!];
        const textures = sourceFile.rendererRef?.current?.getTextures();

        return {
          sourceSpectrogramTex: { value: textures?.packed.texture || placeholderTexture },
          sourceSpectrogramTextureSize: { value: sourceFile.spectrogramData.packedTextureSize },
          sourceInverseMapTex: { value: textures?.inverse || placeholderTexture },
          sourceMetadataTex: { value: textures?.metadata || placeholderTexture },
          sourceMinFreq: { value: sourceFile.spectrogramData.minFreq },
          sourceBandsPerOctave: { value: sourceFile.spectrogramData.bandsPerOctave },
          sourceFrameCount: { value: sourceFile.spectrogramData.numFrames },
          sourceBandCount: { value: sourceFile.spectrogramData.numBands },
          sourceChannelCount: { value: sourceFile.spectrogramData.numChannels },
          sourceSampleRate: { value: sourceFile.spectrogramData.sampleRate },
          destSpectrogramTex: { value: destTexture.texture || placeholderTexture },
          destSpectrogramTextureSize: { value: spectrogramData.packedTextureSize },
          destInverseMapTex: { value: inverseMapTex || placeholderTexture },
          destMetadataTex: { value: metadataTex || placeholderTexture },
          destMinFreq: { value: spectrogramData.minFreq },
          destBandsPerOctave: { value: spectrogramData.bandsPerOctave },
          destFrameCount: { value: spectrogramData.numFrames },
          destBandCount: { value: spectrogramData.numBands },
          destChannelCount: { value: spectrogramData.numChannels },
          destSampleRate: { value: spectrogramData.sampleRate },
          originalSpectrogramTex: { value: originalPackedDataTex || placeholderTexture },
          viewZoomPower: { value: viewZoomPower },
          viewOffset: { value: viewOffset },
          ...(() => {
            // Calculate envelope boundaries on CPU
            const envelopeX = calculateEnvelopeBoundaries(
              stepState.brushEnvelopeDelayTime,
              stepState.brushEnvelopeAttackTime,
              stepState.brushEnvelopeSustainTime,
              stepState.brushEnvelopeReleaseTime,
              bpm,
              totalDuration,
              spectrogramData.bandsPerOctave,
              spectrogramData.numBands,
              true,
            );
            const envelopeY = calculateEnvelopeBoundaries(
              stepState.brushEnvelopeDelayPitch,
              stepState.brushEnvelopeAttackPitch,
              stepState.brushEnvelopeSustainPitch,
              stepState.brushEnvelopeReleasePitch,
              bpm,
              totalDuration,
              spectrogramData.bandsPerOctave,
              spectrogramData.numBands,
              false,
            );

            return {
              brushBottomLeftUv: { value: cursorPos },
              envelopeDelayEndX: { value: envelopeX.delayEnd },
              envelopeAttackEndX: { value: envelopeX.attackEnd },
              envelopeSustainEndX: { value: envelopeX.sustainEnd },
              envelopeReleaseEndX: { value: envelopeX.releaseEnd },
              envelopeDelayEndY: { value: envelopeY.delayEnd },
              envelopeAttackEndY: { value: envelopeY.attackEnd },
              envelopeSustainEndY: { value: envelopeY.sustainEnd },
              envelopeReleaseEndY: { value: envelopeY.releaseEnd },
            };
          })(),
          brushSizeUv: { value: brushSizeUv },
          brushIntensity: {
            value: {
              value: stepState.brushIntensity / 100,
              minValue: 0,
              maxValue: 1,
              modulationAmounts: getModAmountValuesNormalized(stepState, "brushIntensity"),
              contextualModAmounts: getContextualModAmountsNormalized(stepState, "brushIntensity"),
            },
          },
          brushPan: {
            value: {
              value: stepState.brushPan / 100,
              minValue: -1,
              maxValue: 1,
              modulationAmounts: getModAmountValuesNormalized(stepState, "brushPan"),
              contextualModAmounts: getContextualModAmountsNormalized(stepState, "brushPan"),
            },
          },
          bpm: { value: bpm },
          sourceOffsetX: { value: sourceOffsetUv.x },
          sourceOffsetY: { value: sourceOffsetUv.y },
          blendMode: { value: stepState.blendMode },
          algorithm: { value: stepState.algorithm },
          magnitudeLimit: { value: state.magnitudeLimit },
          wrapMode: { value: stepState.brushWrapMode },
          ...(() => {
            const modulatorUniforms = buildModulatorUniforms(
              bpm,
              totalDuration,
              spectrogramData.bandsPerOctave,
              spectrogramData.numBands,
              stepState,
            );
            return {
              modulators: { value: modulatorUniforms },
              gainLut: { value: modulatorScaleLut || placeholderTexture },
              modulator1ImageTex: { value: modulator1Texture || placeholderTexture },
              modulator2ImageTex: { value: modulator2Texture || placeholderTexture },
              modulator3ImageTex: { value: modulator3Texture || placeholderTexture },
              modulator1SeqDataTex: { value: modulatorUniforms[0]?.seqDataTex || placeholderTexture },
              modulator2SeqDataTex: { value: modulatorUniforms[1]?.seqDataTex || placeholderTexture },
              modulator3SeqDataTex: { value: modulatorUniforms[2]?.seqDataTex || placeholderTexture },
            };
          })(),
        };
      };

      // Calculate maximum brush size across all steps (for display purposes)
      // This ensures the preview shows the full extent of all steps
      const activeStepState = createStepStateView(state, state.activeStepIndex);
      const brushSizeUv = new Vector2(0, 0);
      for (let i = 0; i < state.steps.length; i++) {
        const stepState = createStepStateView(state, i);
        const stepBrushSize = calculateBrushSizeUv(stepState);
        brushSizeUv.x = Math.max(brushSizeUv.x, stepBrushSize.x);
        brushSizeUv.y = Math.max(brushSizeUv.y, stepBrushSize.y);
      }

      // Render brush stroke if requested
      if (applyStroke.current && cursorPos.x >= 0) {
        const sourceFile = openFiles[state.sourceFile!];
        const sourceRendererRef = sourceFile.rendererRef;
        const textures = sourceRendererRef?.current?.getTextures();

        if (!textures) {
          return;
        }

        // Calculate source offset using the helper function (using active step for envelope values)
        const sourceOffsetUv = calculateSourceOffset(
          activeStepState,
          cursorPos,
          bpm,
          totalDuration,
          sourceFile.spectrogramData,
          bpm,
          totalDuration,
        );

        const currentReadFBO = pingPong.current === 0 ? fbo1 : fbo2;
        const destinationFbo = pingPong.current === 0 ? fbo2 : fbo1;
        const preview = strokeParams.current?.preview ?? false;

        // Determine the initial source FBO based on sourceDataMode and which file is the source
        // Use active step's sourceDataMode for the initial determination
        const isSameFile = sourceFile.id === fileId;
        let initialSourceFbo =
          activeStepState.sourceDataMode === "original"
            ? { texture: textures!.original }
            : isSameFile
              ? currentReadFBO
              : textures!.packed;

        let tempFboA = passFbo1;
        let tempFboB = passFbo2;

        // For multi-step rendering, we iterate through all steps sequentially
        // The output of one step becomes the input for the next
        let stepInputFbo: WebGLRenderTarget | { texture: DataTexture } = initialSourceFbo;

        // Non-cumulative strokes: use snapshot as source to prevent self-feedback
        if (!state.cumulativeStrokes && isSameFile && activeStepState.sourceDataMode !== "original") {
          stepInputFbo = strokeStartFbo;
          initialSourceFbo = strokeStartFbo;
        }

        const numSteps = state.steps.length;

        // Generate random value seeded by position using Perlin noise
        const strokeRandom = (noise2D(cursorPos.x * 50, cursorPos.y * 50) + 1) / 2;
        for (let stepIndex = 0; stepIndex < numSteps; stepIndex++) {
          const stepState = createStepStateView(state, stepIndex);
          const stepBrushSizeUv = calculateBrushSizeUv(stepState);

          // Determine the blend destination for this step
          // Subsequent steps blend with the previous step's output so that
          // pixels outside their envelope preserve the previous step's changes
          const blendDestFbo = stepIndex === 0 ? currentReadFBO : stepInputFbo;

          // Build common uniforms for this step
          const commonUniforms = buildStepUniforms(stepState, stepBrushSizeUv, sourceOffsetUv, blendDestFbo);

          // Determine source texture based on this step's sourceDataMode
          // "original" = read from original source file spectrogram
          // "current" = read from previous step's output (or initial source for step 1)
          const stepSourceDataMode = stepState.sourceDataMode;
          const stepSourceFbo =
            stepSourceDataMode === "original"
              ? { texture: textures!.original } // Use original unmodified source data
              : stepInputFbo; // Use previous step's output (or initial source for step 1)

          // Override the source texture to use the correct input for this step
          commonUniforms.sourceSpectrogramTex.value = stepSourceFbo.texture;

          // Get enabled effects in order for this step
          const stepEffectOrder = stepState.effectOrder as { effect: EffectType; enabled: boolean }[];
          const enabledEffects = stepEffectOrder.filter(({ enabled }) => enabled).map(({ effect }) => effect);

          // If no effects are enabled, add a passthrough effect
          if (enabledEffects.length === 0) {
            enabledEffects.push("passthrough");
          }

          // Create the iterative uniforms set for subsequent passes
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

          // Reset currentReadFbo to the step's input for effect processing
          let currentReadFbo = stepInputFbo;

          const isLastStep = stepIndex === numSteps - 1;

          // Apply each enabled effect in order, with iterations
          for (let effectIndex = 0; effectIndex < enabledEffects.length; effectIndex++) {
            const effectId = enabledEffects[effectIndex];
            const effect = effects[effectId];
            const numPasses = effect.materials.length;
            const brushIterations = stepState.brushIterations as number;

            for (let i = 0; i < brushIterations; i++) {
              for (let p = 0; p < numPasses; p++) {
                const isFirstEffect = effectIndex === 0;
                const isFirstIteration = i === 0;
                const isFirstPass = p === 0;
                const uniformsForThisIteration =
                  isFirstEffect && isFirstIteration && isFirstPass ? { ...commonUniforms } : { ...iterativeUniforms };

                // Add contextual modulation uniforms for this iteration/step
                const cursorPos = commonUniforms.brushBottomLeftUv.value as Vector2;
                const brushSizeUv = commonUniforms.brushSizeUv.value as Vector2;
                const brushCenterTime = cursorPos.x + brushSizeUv.x / 2;
                const brushCenterPitch = cursorPos.y + brushSizeUv.y / 2;
                uniformsForThisIteration.strokeIterationNormalized = {
                  value: brushIterations > 1 ? i / (brushIterations - 1) : 0,
                };
                uniformsForThisIteration.strokeTimePosition = { value: brushCenterTime };
                uniformsForThisIteration.strokePitchPosition = { value: brushCenterPitch };
                uniformsForThisIteration.strokeRandom = { value: strokeRandom };
                uniformsForThisIteration.strokeStepNormalized = {
                  value: numSteps > 1 ? stepIndex / (numSteps - 1) : 0,
                };

                const material = effect.materials[p];
                fboMesh.material = material;

                const isLastEffect = effectIndex === enabledEffects.length - 1;
                const isLastIteration = i === brushIterations - 1;
                const isLastPass = p === numPasses - 1;
                const isFinalPassOfStep = isLastEffect && isLastIteration && isLastPass;
                const isFinalPass = isFinalPassOfStep && isLastStep;
                const currentWriteFbo = isFinalPass ? destinationFbo : tempFboA;

                const inputTexture = currentReadFbo.texture;

                // The "source" on the first effect/iteration/pass is already set correctly in commonUniforms
                // (respecting sourceDataMode). For subsequent passes, use the previous pass output.
                if (!(isFirstEffect && isFirstIteration && isFirstPass)) {
                  uniformsForThisIteration.sourceSpectrogramTex = { value: inputTexture };
                }

                // The "destination" (for blending) is the original target on the first pass.
                // For all subsequent iterative passes, the destination is the source (self-modification).
                uniformsForThisIteration.destSpectrogramTex = {
                  value: isFirstEffect && isFirstIteration ? commonUniforms.destSpectrogramTex.value : inputTexture,
                };

                // Pass the mask if enabled (non-cumulative mode)
                if (!state.cumulativeStrokes) {
                  const currentMaskFbo = maskPingPong.current === 0 ? strokeMaskFbo : strokeMaskFbo2;
                  (uniformsForThisIteration as any).useStrokeMask = { value: true };
                  (uniformsForThisIteration as any).strokeMaskTex = { value: currentMaskFbo.texture };
                } else {
                  (uniformsForThisIteration as any).useStrokeMask = { value: false };
                  (uniformsForThisIteration as any).strokeMaskTex = { value: placeholderTexture };
                }

                effect.updateEffectUniforms({
                  commonUniforms: uniformsForThisIteration,
                  passIndex: p,
                  file: sourceFile,
                  state: stepState,
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

          // The output of this step becomes the input for the next step
          stepInputFbo = currentReadFbo;
        }

        gl.setRenderTarget(null);

        // If the stroke is not a preview, commit the changes
        if (!preview) {
          pingPong.current = 1 - pingPong.current;
          displayMode.current = "committed";

          // Update stroke mask for non-cumulative mode using ping-pong
          if (!state.cumulativeStrokes) {
            // Ping-pong: read from current mask, write to the other
            const currentMaskFbo = maskPingPong.current === 0 ? strokeMaskFbo : strokeMaskFbo2;
            const nextMaskFbo = maskPingPong.current === 0 ? strokeMaskFbo2 : strokeMaskFbo;

            const activeStep = createStepStateView(state, state.activeStepIndex);
            const brushSizeUv = calculateBrushSizeUv(activeStep);

            maskMaterial.uniforms.currentMaskTex.value = currentMaskFbo.texture;
            maskMaterial.uniforms.destMetadataTex.value = metadataTex;
            maskMaterial.uniforms.destInverseMapTex.value = inverseMapTex;
            maskMaterial.uniforms.destSpectrogramTextureSize.value = spectrogramData.packedTextureSize;
            maskMaterial.uniforms.destFrameCount.value = spectrogramData.numFrames;
            maskMaterial.uniforms.destBandCount.value = spectrogramData.numBands;
            maskMaterial.uniforms.brushSizeUv.value = brushSizeUv;
            maskMaterial.uniforms.brushIntensity.value = {
              value: activeStep.brushIntensity / 100,
              minValue: 0,
              maxValue: 1,
              modulationAmounts: [0, 0, 0],
              contextualModAmounts: [0, 0, 0, 0, 0],
            };

            const envelopeX = calculateEnvelopeBoundaries(
              activeStep.brushEnvelopeDelayTime,
              activeStep.brushEnvelopeAttackTime,
              activeStep.brushEnvelopeSustainTime,
              activeStep.brushEnvelopeReleaseTime,
              bpm,
              totalDuration,
              spectrogramData.bandsPerOctave,
              spectrogramData.numBands,
              true,
            );
            const envelopeY = calculateEnvelopeBoundaries(
              activeStep.brushEnvelopeDelayPitch,
              activeStep.brushEnvelopeAttackPitch,
              activeStep.brushEnvelopeSustainPitch,
              activeStep.brushEnvelopeReleasePitch,
              bpm,
              totalDuration,
              spectrogramData.bandsPerOctave,
              spectrogramData.numBands,
              false,
            );

            maskMaterial.uniforms.brushBottomLeftUv.value = cursorPos;

            maskMaterial.uniforms.envelopeDelayEndX.value = envelopeX.delayEnd;
            maskMaterial.uniforms.envelopeAttackEndX.value = envelopeX.attackEnd;
            maskMaterial.uniforms.envelopeSustainEndX.value = envelopeX.sustainEnd;
            maskMaterial.uniforms.envelopeReleaseEndX.value = envelopeX.releaseEnd;
            maskMaterial.uniforms.envelopeDelayEndY.value = envelopeY.delayEnd;
            maskMaterial.uniforms.envelopeAttackEndY.value = envelopeY.attackEnd;
            maskMaterial.uniforms.envelopeSustainEndY.value = envelopeY.sustainEnd;
            maskMaterial.uniforms.envelopeReleaseEndY.value = envelopeY.releaseEnd;

            fboMesh.material = maskMaterial;
            gl.setRenderTarget(nextMaskFbo);
            gl.render(fboScene, camera);
            gl.setRenderTarget(null);

            // Flip ping-pong for next frame
            maskPingPong.current = 1 - maskPingPong.current;
          }

          // Mark FBO data cache as dirty since we've modified the buffer
          fboDataDirty.current = true;
        }

        applyStroke.current = false;
      }

      // Update display material uniforms (once per frame at the end)
      const currentFBO = pingPong.current === 0 ? fbo1 : fbo2;
      const nextFBO = pingPong.current === 0 ? fbo2 : fbo1;
      const displayTexture = displayMode.current === "committed" ? currentFBO.texture : nextFBO.texture;

      const hoveredFile = state.hoveredFile ? openFiles[state.hoveredFile] : null;

      displayMaterial.uniforms.sourceSpectrogramTex.value = displayTexture || placeholderTexture;
      displayMaterial.uniforms.sourceInverseMapTex.value = inverseMapTex || placeholderTexture;
      displayMaterial.uniforms.sourceMetadataTex.value = metadataTex || placeholderTexture;
      displayMaterial.uniforms.sourceMinFreq.value = spectrogramData.minFreq;
      displayMaterial.uniforms.sourceBandsPerOctave.value = spectrogramData.bandsPerOctave;
      displayMaterial.uniforms.sourceFrameCount.value = spectrogramData.numFrames;
      displayMaterial.uniforms.sourceBandCount.value = spectrogramData.numBands;
      displayMaterial.uniforms.sourceChannelCount.value = spectrogramData.numChannels;
      displayMaterial.uniforms.sourceSampleRate.value = spectrogramData.sampleRate;
      displayMaterial.uniforms.sourceSpectrogramTextureSize.value = spectrogramData.packedTextureSize;
      displayMaterial.uniforms.gridSize.value = state.gridSizeBeats;
      displayMaterial.uniforms.bpm.value = bpm;
      displayMaterial.uniforms.minDb.value = state.displayMinDb;
      displayMaterial.uniforms.maxDb.value = state.displayMaxDb;

      displayMaterial.uniforms.brushBottomLeftUv.value = cursorPos;
      displayMaterial.uniforms.brushSizeUv.value = brushSizeUv;
      displayMaterial.uniforms.sourceBrushSizeUv.value = (() => {
        const targetFile = hoveredFile || file;
        const targetBpm = state.filepathsBpm[targetFile.filePath] || 120;
        const targetDuration = targetFile.spectrogramData.numFrames / targetFile.spectrogramData.sampleRate;

        let maxTimeUv = 0;
        let maxPitchUv = 0;
        for (let i = 0; i < state.steps.length; i++) {
          const stepState = createStepStateView(state, i);
          const timeUv = unitsToUv(
            stepState.brushEnvelopeDelayTime +
            stepState.brushEnvelopeAttackTime +
            stepState.brushEnvelopeSustainTime +
            stepState.brushEnvelopeReleaseTime,
            0,
            targetBpm,
            targetDuration,
            targetFile.spectrogramData.bandsPerOctave,
            targetFile.spectrogramData.numBands,
          );
          const pitchUv = unitsToUv(
            0,
            stepState.brushEnvelopeDelayPitch +
            stepState.brushEnvelopeAttackPitch +
            stepState.brushEnvelopeSustainPitch +
            stepState.brushEnvelopeReleasePitch,
            targetBpm,
            targetDuration,
            targetFile.spectrogramData.bandsPerOctave,
            targetFile.spectrogramData.numBands,
          );
          maxTimeUv = Math.max(maxTimeUv, timeUv.x);
          maxPitchUv = Math.max(maxPitchUv, pitchUv.y);
        }
        return new Vector2(maxTimeUv || 0.1, maxPitchUv || 0.1);
      })();

      displayMaterial.uniforms.showTargetRectangle.value = Boolean(
        state.cursorVisible && cursorPos.x >= 0 && (isMouseOverAnyFile || isActiveFile),
      );
      displayMaterial.uniforms.showSourceRectangle.value = Boolean(
        state.cursorVisible && isSourceFile && (isMouseOverAnyFile || cursorPos.x >= 0),
      );
      displayMaterial.uniforms.viewZoomPower.value = viewZoomPower;
      displayMaterial.uniforms.viewOffset.value = viewOffset;
      displayMaterial.uniforms.wrapMode.value = activeStepState.brushWrapMode;

      // Calculate and update grid values
      const gridSizeBeats = state.gridSizeBeats;
      const gridSizeSemis = state.gridSizeSemis;

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
      if (state.sourceFile) {
        const sourceFileData = openFiles[state.sourceFile];
        if (sourceFileData) {
          const sourceBpm = state.filepathsBpm[sourceFileData.filePath];
          const sourceTotalDuration =
            sourceFileData.spectrogramData.numFrames / sourceFileData.spectrogramData.sampleRate;

          const sourceOffsetUv = calculateSourceOffset(
            activeStepState,
            cursorPos,
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

      const dataTex = new DataTexture(data, packedTextureSize.x, packedTextureSize.y, RGBAFormat, FloatType);
      dataTex.needsUpdate = true;

      glRef.current.initTexture(dataTex);

      fboMesh.material = copyMaterial;
      copyMaterial.uniforms.inputTex.value = dataTex;

      glRef.current.setRenderTarget(fbo1);
      glRef.current.render(fboScene, cameraRef.current);
      glRef.current.setRenderTarget(null);

      // Also snapshot this new state to strokeStartFbo
      // This ensures that if the user starts a stroke immediately after undo/redo,
      // the stroke source is correct.
      snapshotToStrokeStart(fbo1.texture);

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
      packed: WebGLRenderTarget;
      inverse: DataTexture;
      metadata: DataTexture;
      original: DataTexture;
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
      useStore.getState().synthesizeFile(fileId);
    };

    /**
     * Reloads all textures from the current spectrogramData.
     * Used when the file is re-analyzed with different parameters.
     */
    const reloadTextures = () => {
      // Dispose old textures
      if (packedDataTex) packedDataTex.dispose();
      if (originalPackedDataTex) originalPackedDataTex.dispose();
      if (inverseMapTex) inverseMapTex.dispose();
      if (metadataTex) metadataTex.dispose();

      // Create new textures using shared helper
      const { packed, inverse, meta } = createTextures();

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

    const beginStroke = () => {
      // Logic moved to initialization and endStroke to ensure consistency
      // The strokeStartFbo is now always kept up to date as "the state before the current action"
    };

    const endStroke = () => {
      const gl = glRef.current;
      if (!gl || !strokeMaskFbo || !strokeMaskFbo2 || !strokeStartFbo || !fboMesh) return;

      // 1. Snapshot the RESULT of the stroke (current FBO) to strokeStartFbo
      // This prepares it for the NEXT stroke.
      const currentReadFBO = pingPong.current === 0 ? fbo1 : fbo2;
      snapshotToStrokeStart(currentReadFBO.texture);

      // 2. Clear both Mask FBOs and reset ping-pong
      const oldClearColor = new Color();
      gl.getClearColor(oldClearColor);
      const oldClearAlpha = gl.getClearAlpha();
      gl.setClearColor(0x000000, 0);

      gl.setRenderTarget(strokeMaskFbo);
      gl.clear(true, false, false);
      gl.setRenderTarget(strokeMaskFbo2);
      gl.clear(true, false, false);
      gl.setRenderTarget(null);

      gl.setClearColor(oldClearColor, oldClearAlpha);
      maskPingPong.current = 0;

      invalidateRef.current?.();
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
        invalidateRef.current?.();
      },
      getFBOData,
      setFBOData,
      getTextures,
      restoreOriginal,
      clearPreview,
      reloadTextures,
      beginStroke,
      endStroke,
      applyStroke: () => {
        // strokeParams are optional, cursorPos is used for position
        applyStroke.current = true;
        invalidateRef.current?.();
      },
    }));

    if (!spectrogramData) {
      return null;
    }

    /**
     * Clears the stroke preview from the display.
     */
    const clearPreview = () => {
      displayMode.current = "committed";
      clearingPreview.current = true;
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
