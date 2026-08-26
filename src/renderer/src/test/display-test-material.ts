import { Color, GLSL3, RawShaderMaterial, Vector2 } from "three";

import { createDefaultUniforms } from "../effects/base-effect";
import displayFrag from "../glsl/display.frag";
import passThroughVert from "../glsl/pass-through.vert";

/** The real display shader with every overlay uniform quiet. */
export function createDisplayTestMaterial(): RawShaderMaterial {
  return new RawShaderMaterial({
    uniforms: {
      ...createDefaultUniforms(),
      sourceBrushSizeUv: { value: new Vector2(0.1, 0.1) },
      minDb: { value: -80 },
      maxDb: { value: 0 },
      bpm: { value: 120 },
      gridSize: { value: 0.25 },
      gridWidthUv: { value: 0 },
      gridHeightUv: { value: 0 },
      barWidthUv: { value: 0 },
      swingOffsetUv: { value: 0 },
      octaveHeightUv: { value: 0 },
      showHorizontalGrid: { value: false },
      showVerticalGrid: { value: false },
      scaleGridEnabled: { value: false },
      scaleOffsets: { value: new Float32Array(12) },
      pitchOffsetSemisFromC0: { value: 0 },
      showTargetRectangle: { value: false },
      showSourceRectangle: { value: false },
      targetRectPulse: { value: 1 },
      targetRectColor: { value: new Color(1, 1, 1) },
      sourceSamplingBottomLeftUv: { value: new Vector2(-1, -1) },
      viewZoomPower: { value: 0 },
      viewOffset: { value: 0 },
      viewZoomPowerY: { value: 0 },
      viewOffsetY: { value: 0 },
      wrapMode: { value: 0 },
      fullScaleDbOffset: { value: 0 },
      previewTex: { value: null },
      previewBinRangesTex: { value: null },
      previewActive: { value: false },
      canvasMetadataTex: { value: null },
      canvasFrameCount: { value: 0 },
      canvasStartFrame: { value: 0 },
      displayFineTex: { value: null },
      displayFineMetaTex: { value: null },
      displayCoarseTex: { value: null },
      displayCoarseMetaTex: { value: null },
      displayLevelBlend: { value: 0 },
      displayPyramidActive: { value: false },
      displayTileTex: { value: null },
      displayTileMetaTex: { value: null },
      displayTileFirst: { value: 0 },
      displayTileCount: { value: 0 },
      displayTileSlots: { value: 1 },
      displayTileTexels: { value: 0 },
      displayTileBlend: { value: 0 },
      displayTileLevel: { value: 0 },
    },
    vertexShader: passThroughVert,
    fragmentShader: displayFrag,
    glslVersion: GLSL3,
  });
}
