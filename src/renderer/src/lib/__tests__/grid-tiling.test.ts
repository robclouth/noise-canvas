import { DataTexture, FloatType, RGBAFormat, Vector2, WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createGL, createSpectrogramTextures } from "../../test/render-harness";
import { snapToSwungGridFloor, stepSwungGrid } from "../utils";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";

// Stamping cell by cell along the time grid has to cover the swept span
// completely: every coefficient whose bin falls between the first cell's start
// and the last cell's end must be painted, with no unpainted slivers at the
// cell seams. Bins are edge-owned (the coefficient sits at the bin's left edge
// k·2^step), and at coarse bands a bin is wider than a grid cell, so seam
// coverage is decided by the membership rule rather than by geometry.

const filePath = "/test/tiling.wav";

function createPlaceholderTexture(): DataTexture {
  const tex = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

async function loadEffects(): Promise<EffectsRegistry> {
  const [{ dynamicsEffect }, { passThroughEffect }] = await Promise.all([
    import("../../effects/dynamics-effect"),
    import("../../effects/passthrough-effect"),
  ]);
  return { dynamics: dynamicsEffect, passthrough: passThroughEffect };
}

describe("grid stamp tiling", () => {
  let gl: WebGLRenderer;
  let placeholderTexture: DataTexture;
  let effects: EffectsRegistry;
  const disposables: StrokeRenderer[] = [];

  // Real-file geometry: 44.1 kHz with one band per octave, so band steps reach
  // 256 and 512 frames while a 1-beat cell is 22050 frames — cell boundaries
  // land between bins at the coarse bands, as they do in any real file. The
  // file is long enough that a frame index no longer survives a float32 round
  // trip through UV, which is what misattributes bins near a stamp edge.
  const sampleRate = 44100;
  // An awkward frame count (odd, not a round multiple), like a real file's:
  // round lengths make frame/frameCount exactly representable far more often
  // and hide the float round trip that misattributes bins.
  const durationSeconds = 882001 / 44100;
  const gridSizeBeats = 1;
  const totalDuration = durationSeconds;
  const intervalFor = (bpm: number) => (60 / bpm) * gridSizeBeats;

  beforeEach(async () => {
    effects = await loadEffects();
    gl = createGL(64, 64);
    placeholderTexture = createPlaceholderTexture();
  });

  afterEach(() => {
    for (const r of disposables.splice(0)) r.dispose();
    gl.dispose();
    placeholderTexture.dispose();
  });

  function makeSpec(): SpectrogramData {
    const spec = createConstantQMockSpectrogramData({
      durationSeconds,
      sampleRate,
      bandsPerOctave: 1,
      minFreq: 27.5,
    });
    const { bandOffsets, bandLengths } = spec.synthesisMetadata;
    for (let band = 0; band < spec.numBands; band++) {
      for (let k = 0; k < bandLengths[band]; k++) {
        const idx = (bandOffsets[band] + k) * 4;
        spec.packedData[idx] = 0.5;
        spec.packedData[idx + 2] = 0.5;
      }
    }
    return spec;
  }

  function makeRenderer(spec: SpectrogramData, id: string): StrokeRenderer {
    const raw = createSpectrogramTextures(spec);
    const strokeTextures: StrokeTextures = {
      packedDataTex: raw.packedDataTex,
      originalPackedDataTex: raw.originalPackedDataTex,
      inverseMapTex: raw.inverseMapTex,
      metadataTex: raw.metadataTex,
      placeholderTexture,
      modulatorScaleLut: placeholderTexture,
      modulator1Texture: placeholderTexture,
      modulator2Texture: placeholderTexture,
      modulator3Texture: placeholderTexture,
    };
    const renderer = new StrokeRenderer(gl, spec, strokeTextures, id, effects);
    renderer.initialize();
    disposables.push(renderer);
    return renderer;
  }

  function sourceFileFor(renderer: StrokeRenderer, spec: SpectrogramData, id: string): SourceFileInfo {
    const tex = renderer.getTextures();
    return {
      id,
      filePath,
      displayName: filePath,
      spectrogramData: spec,
      textures: { packed: tex.packed, inverse: tex.inverse, metadata: tex.metadata, original: tex.original },
    };
  }

  // The Eraser factory brush: dynamics at -80 dB, hard time envelope, brush
  // sized to the grid cell, full pitch range.
  function eraserState(bpm: number, gridSwing: number): State {
    const base = {
      brushSizeTime: 0,
      // A limited pitch range, like a real brush: it puts the renderer on the
      // scissored copy-back path that a full-height brush skips.
      brushSizePitch: 12,
      brushIntensity: 100,
      brushCurveTime: 100,
      brushSkewTime: 0,
      brushCurvePitch: 100,
      brushSkewPitch: 0,
      brushWrapMode: 0,
      // The app's default: each dab blends from the stroke-start canvas through
      // the stroke mask, so a bin no dab claims is restored rather than merely
      // left unpainted — which is what makes a misattributed bin visible.
      accumulate: false,
      snapTime: true,
      gridSizeBeats,
      gridSwing,
      filepathsBpm: { [filePath]: bpm },
      dynamicsGainDb: -80,
      dynamicsThresholdDb: 0,
      dynamicsUpperRatio: 1,
      dynamicsLowerRatio: 1,
      effects: [{ id: "eraser-dynamics", effect: "dynamics", enabled: true, params: { dynamicsGainDb: -80 } }],
    };
    const state = createMockState(base as Partial<State>);
    Object.assign(state.brushes[0].steps[0] as unknown as Record<string, unknown>, base);
    return state;
  }

  function params(cursorX: number, bpm: number): StrokeParams {
    return {
      cursorPos: new Vector2(cursorX, 0.5),
      preview: false,
      bpm,
      totalDuration,
      viewZoomPower: 0,
      viewOffset: 0,
      viewZoomPowerY: 0,
      viewOffsetY: 0,
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
    };
  }

  // Cell starts as the UI's snapping produces them, walking the swung grid.
  function cellStarts(bpm: number, gridSwing: number): number[] {
    const interval = intervalFor(bpm);
    const starts: number[] = [];
    let t = snapToSwungGridFloor(0, interval, gridSwing / 100);
    while (t < totalDuration - 1e-9) {
      starts.push(t);
      t = stepSwungGrid(t, interval, gridSwing / 100, 1);
    }
    return starts;
  }

  // 60 bpm puts every cell boundary on a frame the coarsest band also has a bin
  // on; 97 bpm and swing both land boundaries between bins, which is where a
  // bin clipped by the span used to drop out.
  it.each([
    { label: "cells aligned to the bin grid", bpm: 60, gridSwing: 0 },
    { label: "cells between bins", bpm: 97, gridSwing: 0 },
    { label: "swung cells", bpm: 60, gridSwing: 60 },
  ])("covers every bin across cell seams when swept cell by cell ($label)", async ({ label, bpm, gridSwing }) => {
    const spec = makeSpec();
    const id = `tile-${label.replace(/\s+/g, "-")}`;
    const renderer = makeRenderer(spec, id);
    const state = eraserState(bpm, gridSwing);
    const source = sourceFileFor(renderer, spec, id);

    // One stroke sweeping every cell, the way dragging paints: dabs composite
    // within a single stroke rather than as independent strokes. Ownership of a
    // bin can shift to the neighbouring cell (the membership probe sits a
    // fraction of a bin inside the edge), so coverage is only well defined over
    // a whole sweep.
    const starts = cellStarts(bpm, gridSwing);
    renderer.beginStroke();
    for (const start of starts) {
      renderer.renderStroke(params(start / totalDuration, bpm), state, source);
    }
    renderer.endStroke();

    const data = await renderer.getFBOData();
    const { bandOffsets, bandLengths, bandStepLog2s } = spec.synthesisMetadata;

    // A band the brush covered is one where most bins were erased; in those,
    // every bin must be erased — a lone survivor is a seam gap.
    const unpainted: string[] = [];
    for (let band = 0; band < spec.numBands; band++) {
      const step = 1 << bandStepLog2s[band];
      const mags: number[] = [];
      for (let k = 0; k < bandLengths[band]; k++) mags.push(data[(bandOffsets[band] + k) * 4]);
      const erased = mags.filter((m) => m <= 0.01).length;
      if (erased < mags.length * 0.5) continue;
      mags.forEach((mag, k) => {
        if (mag > 0.01) {
          const frame = k * step;
          const cell = starts.filter((s) => s * sampleRate <= frame).pop() ?? 0;
          unpainted.push(
            `band ${band} step ${step} bin ${k} frame ${frame} ` +
              `(cell starts ${(cell * sampleRate).toFixed(2)}f, offset ${(frame - cell * sampleRate).toFixed(2)}f) mag ${mag.toFixed(3)}`,
          );
        }
      });
    }

    expect(unpainted, `${unpainted.length} bins left unpainted between cells`).toEqual([]);
  });
});
