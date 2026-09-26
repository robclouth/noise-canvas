import { Color, GLSL3, RawShaderMaterial, Texture, Vector2 } from "three";
import { createDefaultUniforms } from "../effects/base-effect";
import displayFrag from "../glsl/display.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { FULL_SCALE_DB_OFFSET } from "./constants";
import type { FileDisplayData, FileViewDescriptor } from "./file-renderer-types";
import { LONE_LAYER_TINT } from "./layer-tint";
import { buildScaleOffsets, minFreqSemisAboveC0 } from "./scale-snap";

/** Creates a view-owned spectral display material. */
export function createFileDisplayMaterial(
  state: Pick<FileViewDescriptor, "displayMinDb" | "displayMaxDb">,
): RawShaderMaterial {
  return new RawShaderMaterial({
    uniforms: {
      ...createDefaultUniforms(),
      sourceBrushSizeUv: { value: new Vector2(0.1, 0.1) },
      minDb: { value: state.displayMinDb },
      maxDb: { value: state.displayMaxDb },
      bpm: { value: 120.0 },
      gridSize: { value: 0.25 },
      gridWidthUv: { value: 0.0 },
      gridHeightUv: { value: 0.0 },
      barWidthUv: { value: 0.0 },
      swingOffsetUv: { value: 0.0 },
      octaveHeightUv: { value: 0.0 },
      showHorizontalGrid: { value: true },
      showVerticalGrid: { value: true },
      scaleGridEnabled: { value: false },
      scaleOffsets: { value: new Float32Array(12) },
      pitchOffsetSemisFromC0: { value: 0.0 },
      leftTint: { value: new Color(LONE_LAYER_TINT.left[0], LONE_LAYER_TINT.left[1], LONE_LAYER_TINT.left[2]) },
      rightTint: {
        value: new Color(LONE_LAYER_TINT.right[0], LONE_LAYER_TINT.right[1], LONE_LAYER_TINT.right[2]),
      },
      drawOverlays: { value: true },
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
      brushWrapSpanX: { value: 1 },
      fullScaleDbOffset: { value: FULL_SCALE_DB_OFFSET },
      previewTex: { value: null as Texture | null },
      previewBinRangesTex: { value: null as Texture | null },
      previewActive: { value: false },
      // The coarse canvas: a dab previewed on it, and a stroke's dabs painted on it.
      coarseMetaTex: { value: null as Texture | null },
      coarseCommittedTex: { value: null as Texture | null },
      coarsePreviewTex: { value: null as Texture | null },
      coarsePreviewBinRangesTex: { value: null as Texture | null },
      coarsePreviewActive: { value: false },
      coarseStrokeBinRangesTex: { value: null as Texture | null },
      coarseStrokeActive: { value: false },
      canvasMetadataTex: { value: null as Texture | null },
      canvasFrameCount: { value: 0 },
      canvasStartFrame: { value: 0 },
      displayFineTex: { value: null as Texture | null },
      displayFineMetaTex: { value: null as Texture | null },
      displayCoarseTex: { value: null as Texture | null },
      displayCoarseMetaTex: { value: null as Texture | null },
      displayLevelBlend: { value: 0.0 },
      displayPyramidActive: { value: false },
      displayCanvasFirst: { value: false },
      displayFinerWanted: { value: false },
      displayLoadingAll: { value: false },
      displayLoading: { value: 0.0 },
      displayTileTex: { value: null as Texture | null },
      displayTileMetaTex: { value: null as Texture | null },
      displayTileFirst: { value: 0.0 },
      displayTileCount: { value: 0.0 },
      displayTileSlots: { value: 1.0 },
      displayTileTexels: { value: 0.0 },
      displayTileBlend: { value: 0.0 },
      displayTileLevel: { value: 0.0 },
    },
    vertexShader: passThroughVert,
    fragmentShader: displayFrag,
    glslVersion: GLSL3,
  });
}

/** Disposes a view's display material. */
export function disposeFileDisplayMaterial(displayMaterial: RawShaderMaterial): void {
  displayMaterial.dispose();
}

/** Binds borrowed spectral inputs and the view transform. */
export function bindFileSpectralInputs(
  displayMaterial: RawShaderMaterial,
  data: FileDisplayData,
  state: FileViewDescriptor,
): void {
  const { spectrogramData, inverseMapTex, metadataTex, canvasView, canvasMetadataTex } = data;
  const { bpm, viewZoomPower, viewOffset, viewZoomPowerY, viewOffsetY } = state;
  const uniforms = displayMaterial.uniforms;
  uniforms.sourceInverseMapTex.value = inverseMapTex;
  uniforms.sourceMetadataTex.value = metadataTex;
  uniforms.canvasMetadataTex.value = canvasMetadataTex;
  uniforms.canvasFrameCount.value = canvasView
    ? canvasView.endFrame - canvasView.startFrame
    : spectrogramData.numFrames;
  uniforms.canvasStartFrame.value = canvasView?.startFrame ?? 0;
  uniforms.sourceMinFreq.value = spectrogramData.minFreq;
  uniforms.sourceBandsPerOctave.value = spectrogramData.bandsPerOctave;
  uniforms.sourceFrameCount.value = spectrogramData.numFrames;
  uniforms.sourceBandCount.value = spectrogramData.numBands;
  uniforms.sourceChannelCount.value = spectrogramData.numChannels;
  uniforms.sourceSampleRate.value = spectrogramData.sampleRate;
  uniforms.sourceSpectrogramTextureSize.value = spectrogramData.packedTextureSize;
  uniforms.gridSize.value = state.gridSizeBeats;
  uniforms.bpm.value = bpm;
  uniforms.minDb.value = state.displayMinDb;
  uniforms.maxDb.value = state.displayMaxDb;
  uniforms.viewZoomPower.value = viewZoomPower;
  uniforms.viewOffset.value = viewOffset;
  uniforms.viewZoomPowerY.value = viewZoomPowerY;
  uniforms.viewOffsetY.value = viewOffsetY;
}

/** Binds the top layer's time, pitch and scale grids. */
export function bindFileTopOverlays(
  displayMaterial: RawShaderMaterial,
  data: FileDisplayData,
  state: FileViewDescriptor,
): void {
  const { spectrogramData } = data;
  const { bpm, totalDuration, viewZoomPower, viewZoomPowerY, viewportWidth, viewportHeight } = state;
  const uniforms = displayMaterial.uniforms;
  // Calculate and update grid values
  const gridSizeBeats = state.gridSizeBeats;
  const gridSizeSemis = state.gridSizeSemis;

  // Horizontal grid (time/beats)
  const beatDurationSeconds = 60.0 / bpm;
  const gridIntervalSeconds = beatDurationSeconds * gridSizeBeats;
  const gridWidthUv = gridSizeBeats > 0 ? gridIntervalSeconds / totalDuration : 0;
  const barWidthUv = gridSizeBeats > 0 ? (beatDurationSeconds * 4.0) / totalDuration : 0;

  // Vertical grid (frequency/semitones). When gridSizeSemis is 0, the pitch grid is in
  // "Scale" mode and the chromatic grid is suppressed in favor of the scale grid.
  const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
  const gridIntervalBands = gridSizeSemis * bandsPerSemitone;
  const gridHeightUv = gridSizeSemis > 0 ? gridIntervalBands / spectrogramData.numBands : 0;
  const octaveHeightUv = gridSizeSemis > 0 ? (12 * bandsPerSemitone) / spectrogramData.numBands : 0;

  // Determine if grid lines should be shown based on spacing (min 10 pixels apart).
  // Multiply by the view zoom factor so zooming in can reveal lines that were too
  // dense at 1x.
  const MIN_GRID_SPACING_PX = 10;
  const zoomX = Math.pow(2, viewZoomPower);
  const zoomY = Math.pow(2, viewZoomPowerY);
  const gridWidthPx = gridWidthUv * viewportWidth * zoomX;
  const gridHeightPx = gridHeightUv * viewportHeight * zoomY;

  uniforms.gridWidthUv.value = gridWidthUv;
  uniforms.gridHeightUv.value = gridHeightUv;
  uniforms.barWidthUv.value = barWidthUv;
  uniforms.swingOffsetUv.value = gridWidthUv * (state.gridSwing / 100) * 0.5;
  uniforms.octaveHeightUv.value = octaveHeightUv;
  uniforms.showHorizontalGrid.value = gridWidthPx >= MIN_GRID_SPACING_PX && gridSizeBeats > 0;
  uniforms.showVerticalGrid.value = gridHeightPx >= MIN_GRID_SPACING_PX && gridSizeSemis > 0;

  // Scale grid: draw a line at every in-scale semitone when scale snap is on. Hide when too dense.
  const semitoneHeightPx = (spectrogramData.bandsPerOctave / 12 / spectrogramData.numBands) * viewportHeight * zoomY;
  uniforms.scaleGridEnabled.value = gridSizeSemis <= 0 && semitoneHeightPx >= MIN_GRID_SPACING_PX;
  uniforms.scaleOffsets.value = buildScaleOffsets(state.scaleTonic, state.scaleType);
  uniforms.pitchOffsetSemisFromC0.value = minFreqSemisAboveC0(spectrogramData.minFreq);
}
