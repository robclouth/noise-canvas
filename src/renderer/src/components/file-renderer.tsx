import { createStepStateView, useStore } from "@/store";
import { useFrame } from "@react-three/fiber";
import { defaultValues } from "@renderer/effects/base-effect";
import { getOpenFileByPath, openFiles } from "@renderer/store/files";
import { State } from "@renderer/store/types";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Camera,
  ClampToEdgeWrapping,
  Color,
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
import { penState } from "../lib/pen-state";
import { useModulatorTexture, usePlaceholderTexture } from "../lib/textures";
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
    if (!spectrogramData) return null;

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
            zoomY: state.filesZoomY[fileId],
            offsetY: state.filesOffsetY[fileId],
            gridBeats: state.gridSizeBeats,
            gridSemis: state.gridSizeSemis,
            minDb: state.displayMinDb,
            maxDb: state.displayMaxDb,
            cursorPosition: state.cursorPosition,
            cursorVisible: state.cursorVisible,
            pickingFileParam: state.pickingFileParam,
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
            if (state.cursorVisible && state.cursorPosition && currentFile?.spectrogramData) {
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
          targetRectPulse: { value: 1.0 },
          // Mantine orange[6] #fd7e14 by default; swapped to blue[6] while picking a source.
          targetRectColor: { value: new Color(0.992, 0.494, 0.078) },
          sourceSamplingBottomLeftUv: { value: new Vector2(-1, -1) },
          viewZoomPower: { value: 0.0 },
          viewOffset: { value: 0.0 },
          viewZoomPowerY: { value: 0.0 },
          viewOffsetY: { value: 0.0 },
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
     * Calculate clone-stamp offset.
     * Base position is in sourceTimeOffset/sourcePitchOffset params (handled in shader with modulation).
     */
    const calculateSourceOffset = useCallback(
      (
        sourcePositionUv: Vector2,
        lockedOffset: { beats: number; pitch: number } | null | undefined,
        mode: string,
        mousePos: Vector2 | null,
        timeScale: number,
        bandScale: number,
      ): Vector2 => {
        if (!mousePos) {
          return new Vector2(0, 0);
        }

        const scaledMouse = new Vector2(mousePos.x * timeScale, mousePos.y * bandScale);

        if (mode === "fixed") {
          return sourcePositionUv.clone().sub(scaledMouse);
        } else if (mode === "anchored") {
          if (lockedOffset) {
            return new Vector2(lockedOffset.beats, lockedOffset.pitch);
          } else {
            return sourcePositionUv.clone().sub(scaledMouse);
          }
        }

        return new Vector2(0, 0);
      },
      [],
    );

    const placeholderTexture = usePlaceholderTexture();

    /**
     * The main render loop, called on every frame.
     * This handles initialization, brush stroke application, and updating the display material.
     */
    useFrame(({ gl, camera, clock, invalidate }) => {
      // Capture refs for use outside of useFrame
      glRef.current = gl;
      cameraRef.current = camera;
      if (!invalidateRef.current) {
        invalidateRef.current = invalidate;
      }

      if (!spectrogramData || !packedDataTex || !inverseMapTex || !metadataTex || !originalPackedDataTex) return;

      const state = useStore.getState();

      const file = openFiles[fileId];
      if (!file || !file.spectrogramData) return;

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

      // Check if this file is referenced as source by the active step
      const activeStepRaw = (state.brushes[state.activeBrushIndex]?.steps ?? [])[state.activeStepIndex];
      const activeStepSourceFile = activeStepRaw?.sourceFile ?? null;
      const sourceFileData = activeStepSourceFile ? getOpenFileByPath(activeStepSourceFile.path) : null;
      const isSourceFile = sourceFileData?.id === fileId;

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
        strokeRendererRef.current = new StrokeRenderer(gl, spectrogramData, textures, fileId, effects);
      }

      const strokeRenderer = strokeRendererRef.current;

      // Initialize StrokeRenderer if not done yet
      if (!strokeRenderer.getIsInitialized()) {
        strokeRenderer.initialize();
        state.synthesizeFile(fileId);

        // Save initial state for undo
        import("@renderer/lib/undo-manager").then(({ getUndoManager }) =>
          getUndoManager(fileId).addState(spectrogramData.packedData, fileId),
        );
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
      const viewZoomPowerY = state.filesZoomY[fileId] ?? 0;
      const viewOffsetY = state.filesOffsetY[fileId] ?? 0;

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
      const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
      const brushSizeUv = new Vector2(0, 0);
      for (let i = 0; i < steps.length; i++) {
        const stepState = createStepStateView(state, i);
        const stepBrushSize = calculateBrushSizeUv(stepState);
        brushSizeUv.x = Math.max(brushSizeUv.x, stepBrushSize.x);
        brushSizeUv.y = Math.max(brushSizeUv.y, stepBrushSize.y);
      }

      // For source file: compute the sampling position in this file's UV space.
      let sourceDisplayPos = new Vector2(-1, -1);
      if (isSourceFile && activeStepSourceFile) {
        const mode = String(activeStepRaw?.sourcePositionMode ?? "anchored");
        const sourcePositionUv = new Vector2(
          (Number(activeStepRaw?.sourceTimeOffset) || 0) / 100,
          (Number(activeStepRaw?.sourcePitchOffset) || 0) / 100,
        );
        const shouldTrackCursor =
          (mode === "fixed" || (mode === "anchored" && state.isStroking)) &&
          state.cursorVisible &&
          state.cursorPosition &&
          state.activeFileId;

        if (shouldTrackCursor) {
          const activeFile = openFiles[state.activeFileId!];
          if (activeFile?.spectrogramData) {
            const activeBpm = state.filepathsBpm[activeFile.filePath] || 120;
            const activeDuration = activeFile.spectrogramData.numFrames / activeFile.spectrogramData.sampleRate;
            const destCursorUv = unitsToUv(
              state.cursorPosition!.beats,
              state.cursorPosition!.pitch,
              activeBpm,
              activeDuration,
              activeFile.spectrogramData.bandsPerOctave,
              activeFile.spectrogramData.numBands,
            );

            const tScale = (activeBpm * activeDuration) / (bpm * totalDuration);
            const bScale = spectrogramData.numBands / activeFile.spectrogramData.numBands;

            const offset = calculateSourceOffset(
              sourcePositionUv,
              activeStepRaw?.lockedOffset,
              mode,
              destCursorUv,
              tScale,
              bScale,
            );
            sourceDisplayPos = new Vector2(
              destCursorUv.x * tScale + offset.x,
              destCursorUv.y * bScale + offset.y,
            );
          }
        } else {
          // At rest: show at the source position
          sourceDisplayPos = sourcePositionUv;
        }
      }

      // Render brush stroke if requested
      if (applyStroke.current && cursorPos.x >= 0) {
        // Resolve source file from active step's sourceFile param
        // If null (self), use this file's own data
        const resolvedSourceFile = sourceFileData ?? openFiles[fileId];
        const resolvedSourceRendererRef = resolvedSourceFile.rendererRef;
        const resolvedSourceTextures = resolvedSourceRendererRef?.current?.getTextures();

        if (!resolvedSourceTextures || !resolvedSourceFile.spectrogramData) {
          return;
        }

        const preview = strokeParams.current?.preview ?? false;

        // Build source file info for StrokeRenderer
        const sourceFileInfo: SourceFileInfo = {
          id: resolvedSourceFile.id,
          filePath: resolvedSourceFile.filePath,
          spectrogramData: resolvedSourceFile.spectrogramData,
          textures: resolvedSourceTextures,
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
            viewZoomPowerY,
            viewOffsetY,
            pressure: penState.pressure,
            tiltX: penState.tiltX,
            tiltY: penState.tiltY,
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
      // While picking a source, never show the stroke preview — just the committed spectrogram + rectangle.
      if (state.pickingFileParam !== null) {
        displayMode.current = "committed";
      }
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
      displayMaterial.uniforms.sourceSamplingBottomLeftUv.value = sourceDisplayPos;
      displayMaterial.uniforms.brushSizeUv.value = brushSizeUv;
      displayMaterial.uniforms.sourceBrushSizeUv.value = (() => {
        // When this file is the source, always compute brush size in this file's coordinate space
        const targetFile = isSourceFile ? file : (hoveredFile || file);
        if (!targetFile.spectrogramData) return new Vector2(0.1, 0.1);
        const targetBpm = state.filepathsBpm[targetFile.filePath] || 120;
        const targetDuration = targetFile.spectrogramData.numFrames / targetFile.spectrogramData.sampleRate;
        const slotSteps = state.brushes[state.activeBrushIndex]?.steps ?? [];

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
        state.cursorVisible && state.hoveredFile === fileId,
      );
      displayMaterial.uniforms.showSourceRectangle.value = isSourceFile;

      const isPicking = state.pickingFileParam !== null;
      displayMaterial.uniforms.targetRectPulse.value = isPicking
        ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(clock.elapsedTime * 2.0 * Math.PI))
        : 1.0;
      (displayMaterial.uniforms.targetRectColor.value as Color).setRGB(
        isPicking ? 0.133 : 0.992,
        isPicking ? 0.545 : 0.494,
        isPicking ? 0.902 : 0.078,
      );
      if (isPicking && state.hoveredFile === fileId) {
        invalidate();
      }
      displayMaterial.uniforms.viewZoomPower.value = viewZoomPower;
      displayMaterial.uniforms.viewOffset.value = viewOffset;
      displayMaterial.uniforms.viewZoomPowerY.value = viewZoomPowerY;
      displayMaterial.uniforms.viewOffsetY.value = viewOffsetY;
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

      // Update source offset uniforms (for display preview)
      if (activeStepSourceFile && sourceFileData?.spectrogramData) {
        const srcBpm = state.filepathsBpm[sourceFileData.filePath] || 120;
        const srcDur = sourceFileData.spectrogramData.numFrames / sourceFileData.spectrogramData.sampleRate;
        const tScale = (bpm * totalDuration) / (srcBpm * srcDur);
        const bScale = spectrogramData.numBands / sourceFileData.spectrogramData.numBands;

        const srcPositionUv = new Vector2(
          (Number(activeStepRaw?.sourceTimeOffset) || 0) / 100,
          (Number(activeStepRaw?.sourcePitchOffset) || 0) / 100,
        );
        const sourceOffsetUv = calculateSourceOffset(
          srcPositionUv,
          activeStepRaw?.lockedOffset,
          String(activeStepRaw?.sourcePositionMode ?? "anchored"),
          cursorPos,
          tScale,
          bScale,
        );

        displayMaterial.uniforms.sourceOffsetX.value = sourceOffsetUv.x;
        displayMaterial.uniforms.sourceOffsetY.value = sourceOffsetUv.y;
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
        // While picking a source file, don't render the brush preview — just the rectangle.
        if (preview && useStore.getState().pickingFileParam !== null) {
          displayMode.current = "committed";
          invalidateRef.current?.();
          return;
        }
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
