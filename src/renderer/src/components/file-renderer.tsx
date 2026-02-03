import { createStepStateView, useStore } from "@/store";
import { useFrame } from "@react-three/fiber";
import { defaultValues } from "@renderer/effects/base-effect";
import { openFiles } from "@renderer/store/files";
import { State } from "@renderer/store/types";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Camera,
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  RawShaderMaterial,
  RGBAFormat,
  RGFormat,
  UniformsUtils,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { effects } from "../effects";
import displayFrag from "../glsl/display.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { withPlatformDefines } from "../lib/shader-utils";
import { SourceFileInfo, StrokeRenderer, StrokeTextures } from "../lib/stroke-renderer";
import { useModulatorTexture, usePlaceholderTexture } from "../lib/textures";
import { getUndoManager } from "../lib/undo-manager";
import { unitsToUv } from "../lib/utils";

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
  /** Gets the dirty region (UV range modified since last clear). Returns null if no modifications. */
  getDirtyRegion: () => { startX: number; endX: number; startY: number; endY: number } | null;
  /** Clears the dirty region tracking (call after synthesis). */
  clearDirtyRegion: () => void;
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
    const strokeRendererRef = useRef<StrokeRenderer | null>(null);

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

    // Subscriptions to global state - consolidated into fewer subscriptions for efficiency
    useEffect(() => {
      // Consolidate display-related subscriptions that all just trigger invalidate
      const unsubDisplay = useStore.subscribe(
        (state) => {
          const file = openFiles[fileId];
          return {
            bpm: file && state.filepathsBpm[file.filePath],
            zoom: state.filesZoom[fileId],
            offset: state.filesOffset[fileId],
            gridBeats: state.gridSizeBeats,
            gridSemis: state.gridSizeSemis,
            minDb: state.displayMinDb,
            maxDb: state.displayMaxDb,
            cursorPosition: state.cursorPosition,
            cursorVisible: state.cursorVisible,
          };
        },
        () => {
          invalidateRef.current?.();
        },
      );

      // Keep activeFileId separate due to special logic
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
        unsubDisplay();
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

    const mesh = useRef<Mesh>(null!);

    // Stroke params for render loop
    const strokeParams = useRef<{ x: number; y: number; preview: boolean } | null>(null);

    // Cleanup StrokeRenderer on unmount or when textures change
    useEffect(() => {
      return () => {
        if (strokeRendererRef.current) {
          strokeRendererRef.current.dispose();
          strokeRendererRef.current = null;
        }
      };
    }, [spectrogramData.textureWidth, spectrogramData.textureHeight]);

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

      // Reset StrokeRenderer when textures change
      if (strokeRendererRef.current) {
        strokeRendererRef.current.dispose();
        strokeRendererRef.current = null;
      }

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
        !spectrogramData ||
        !packedDataTex ||
        !inverseMapTex ||
        !metadataTex ||
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

      // Create StrokeRenderer if not exists
      if (!strokeRendererRef.current) {
        const textures: StrokeTextures = {
          packedDataTex,
          originalPackedDataTex,
          inverseMapTex,
          metadataTex,
          placeholderTexture,
          modulatorScaleLut,
          modulator1Texture,
          modulator2Texture,
          modulator3Texture,
        };
        strokeRendererRef.current = new StrokeRenderer(
          gl,
          spectrogramData,
          textures,
          fileId,
          effects,
        );
      }

      const strokeRenderer = strokeRendererRef.current;

      // Initialize StrokeRenderer if not done yet
      if (!strokeRenderer.getIsInitialized()) {
        strokeRenderer.initialize();
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
        strokeRenderer.getIsInitialized()
      ) {
        return;
      }

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

      // Calculate maximum brush size across all steps (for display purposes)
      const activeStepState = createStepStateView(state, state.activeStepIndex);
      const steps = state.slots[state.activeSlotIndex] ?? [];
      const brushSizeUv = new Vector2(0, 0);
      for (let i = 0; i < steps.length; i++) {
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

        const preview = strokeParams.current?.preview ?? false;

        // Build source file info for StrokeRenderer
        const sourceFileInfo: SourceFileInfo = {
          id: sourceFile.id,
          filePath: sourceFile.filePath,
          spectrogramData: sourceFile.spectrogramData,
          textures,
        };

        // Render the stroke using StrokeRenderer
        strokeRenderer.renderStroke(
          {
            cursorPos,
            preview,
            bpm,
            totalDuration,
            viewZoomPower,
            viewOffset,
          },
          state,
          sourceFileInfo,
        );

        if (!preview) {
          displayMode.current = "committed";
        }

        applyStroke.current = false;
      }

      // Update display material uniforms (once per frame at the end)
      const isPreview = displayMode.current === "preview";
      const displayTexture = strokeRenderer.getDisplayTexture(isPreview);

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
        const slotSteps = state.slots[state.activeSlotIndex] ?? [];

        let maxTimeUv = 0;
        let maxPitchUv = 0;
        for (let i = 0; i < slotSteps.length; i++) {
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
     * Reads the pixel data from the current FBO asynchronously.
     */
    const getFBOData = async (): Promise<Float32Array> => {
      if (!strokeRendererRef.current) {
        throw new Error("StrokeRenderer not initialized");
      }
      return strokeRendererRef.current.getFBOData();
    };

    /**
     * Sets the FBO data from an external source (e.g., for undo/redo).
     */
    const setFBOData = (data: Float32Array) => {
      if (!strokeRendererRef.current) return;

      strokeRendererRef.current.setFBOData(data);
      applyStroke.current = false;
      displayMode.current = "committed";
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
      if (!strokeRendererRef.current || !inverseMapTex || !metadataTex || !originalPackedDataTex) return null;
      return strokeRendererRef.current.getTextures();
    };

    /**
     * Restores the spectrogram to its original, unmodified state.
     */
    const restoreOriginal = () => {
      if (strokeRendererRef.current) {
        strokeRendererRef.current.restoreOriginal();
      }
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

      // Dispose and reset StrokeRenderer
      if (strokeRendererRef.current) {
        strokeRendererRef.current.dispose();
        strokeRendererRef.current = null;
      }

      // Create new textures using shared helper
      const { packed, inverse, meta } = createTextures();

      setPackedDataTex(packed);
      setOriginalPackedDataTex(packed.clone());
      setInverseMapTex(inverse);
      setMetadataTex(meta);

      invalidateRef.current();
    };

    const beginStroke = () => {
      if (strokeRendererRef.current) {
        strokeRendererRef.current.beginStroke();
      }
    };

    const endStroke = () => {
      if (strokeRendererRef.current) {
        strokeRendererRef.current.endStroke();
      }
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
      getDirtyRegion: () => strokeRendererRef.current?.getDirtyRegion() ?? null,
      clearDirtyRegion: () => strokeRendererRef.current?.clearDirtyRegion(),
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
