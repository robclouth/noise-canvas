import { Vector2, WebGLRenderer } from "three";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import {
  createHarnessTextures,
  createSourceFile,
  createStateForEffects,
  disposeHarnessTextures,
  makeStrokeParams,
  toStrokeTextures,
  type EffectStateOptions,
  type HarnessTextures,
} from "../../test/render-harness";
import type { EffectType } from "../../effects/types";
import type { SpectrogramData, State } from "../../store/types";
import { readRenderTargetPixelsAsync } from "../async-readpixels";
import { BRUSH_SIZE_PITCH_FULL } from "../utils";
import { StrokeRenderer, type EffectsRegistry } from "../stroke-renderer";

/**
 * Equivalence guard for the footprint render and copy-back optimisation.
 *
 * The optimisation draws every pass but the last into the brush's packed rows
 * and the last pass into the brush footprint alone, then folds the footprint
 * back into the canonical buffer, instead of rendering the whole texture and
 * ping-pong-swapping. It must be behaviour-preserving: for any committed
 * stroke the resulting spectrogram must be byte-identical to the legacy path.
 * We assert that by running the same strokes through both paths (the legacy
 * one forced via `disableScissorCopyBack`) and comparing the full read-back.
 */

let effects: EffectsRegistry;

beforeAll(async () => {
  effects = (await import("../../effects")).effects as EffectsRegistry;
});

describe("footprint copy-back equivalence", () => {
  let gl: WebGLRenderer;
  let spectrogramData: SpectrogramData;
  let textures: HarnessTextures;

  beforeEach(() => {
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(256, 256);
    // Large enough (256 bands) that a localized brush scissors to a small row
    // band rather than tripping the ">=80% of bands" full-texture fallback.
    spectrogramData = createMockSpectrogramData({ numFrames: 1024, numBands: 256, pattern: "gradient" });
    textures = createHarnessTextures(spectrogramData);
  });

  afterEach(() => {
    disposeHarnessTextures(textures);
    gl.dispose();
  });

  function makeRenderer(legacy: boolean): StrokeRenderer {
    const r = new StrokeRenderer(gl, spectrogramData, toStrokeTextures(textures), "copyback", effects);
    r.disableScissorCopyBack = legacy;
    r.initialize();
    return r;
  }

  // A small brush at a few positions. The state's steps do not accumulate, so
  // every dab also updates the stroke mask; the fourth dab sits far from the
  // others in pitch, so the mask's row union has to widen rather than follow
  // one dab.
  const smallBrushPositions = [
    new Vector2(0.45, 0.5),
    new Vector2(0.5, 0.55),
    new Vector2(0.55, 0.5),
    new Vector2(0.5, 0.8),
    new Vector2(0.5, 0.5),
  ];

  async function paintAndRead(legacy: boolean, makeState: () => State, positions: Vector2[]): Promise<Float32Array> {
    const r = makeRenderer(legacy);
    try {
      const sourceFile = createSourceFile(r, spectrogramData);
      const state = makeState();
      for (const p of positions) {
        r.renderStroke(makeStrokeParams(p, spectrogramData, { totalDuration: 4 }), state, sourceFile);
      }
      return await r.getFBOData();
    } finally {
      r.dispose();
    }
  }

  function expectIdentical(optimized: Float32Array, legacy: Float32Array): void {
    expect(optimized.length).toBe(legacy.length);
    let maxDiff = 0;
    let firstDiffIndex = -1;
    for (let i = 0; i < optimized.length; i++) {
      const d = Math.abs(optimized[i] - legacy[i]);
      if (d > maxDiff) maxDiff = d;
      if (d !== 0 && firstDiffIndex === -1) firstDiffIndex = i;
    }
    // Same shader math on both paths → expect exact equality.
    expect(maxDiff, `first diff at index ${firstDiffIndex}`).toBe(0);
  }

  function stateFor(enabled: EffectType[], options: EffectStateOptions): () => State {
    return () => createStateForEffects(enabled, options);
  }

  it("scissors a localized brush (precondition: not the full-texture fallback)", () => {
    const r = makeRenderer(false);
    try {
      // brushBottomLeftUv / sizeUv around the painted band; non-null means the
      // small-brush row path is actually exercised by this fixture.
      const rows = r.calculateScissorRows(new Vector2(0.45, 0.46), new Vector2(0.1, 0.08));
      expect(rows).not.toBeNull();
    } finally {
      r.dispose();
    }
  });

  it("a two-pass effect with mask updates matches the legacy full-texture path", async () => {
    const makeState = stateFor(["blur"], { brushSizeTime: 0.5, brushSizePitch: 12 });
    expectIdentical(
      await paintAndRead(false, makeState, smallBrushPositions),
      await paintAndRead(true, makeState, smallBrushPositions),
    );
  });

  // Iteration two reads iteration one's output shifted in time, outside the
  // brush footprint but inside the rows the intermediate pass wrote.
  it("an iterated time shift reading past the footprint matches the legacy path", async () => {
    const makeState = () => {
      const state = createStateForEffects(["transform"], {
        brushSizeTime: 0.5,
        brushSizePitch: 12,
        stepOverrides: { brushIterations: 2 },
      });
      const step = state.brushes[state.activeBrushIndex].steps[0] as unknown as Record<string, unknown>;
      const items = step.effects as { params: Record<string, unknown> }[];
      items[0].params = { transformShiftBeats: 0.75 };
      return state;
    };
    expectIdentical(
      await paintAndRead(false, makeState, smallBrushPositions),
      await paintAndRead(true, makeState, smallBrushPositions),
    );
  });

  // A full-pitch brush spans every band, so there are no rows to scissor, but
  // its final pass still writes only its time window of each band.
  it("a full-pitch brush with a narrow time window matches the legacy path", async () => {
    const makeState = stateFor(["blur"], { brushSizeTime: 0.25, brushSizePitch: BRUSH_SIZE_PITCH_FULL });
    const positions = [new Vector2(0.3, 0.5), new Vector2(0.35, 0.5), new Vector2(0.7, 0.5)];
    expectIdentical(await paintAndRead(false, makeState, positions), await paintAndRead(true, makeState, positions));
  });

  it("a brush that wraps past the end of the file matches the legacy path", async () => {
    const makeState = stateFor(["blur"], {
      brushSizeTime: 0.5,
      brushSizePitch: 12,
      stepOverrides: { brushWrapMode: 3 },
    });
    const positions = [new Vector2(0.95, 0.5), new Vector2(0.97, 0.98), new Vector2(0.5, 0.5)];
    expectIdentical(await paintAndRead(false, makeState, positions), await paintAndRead(true, makeState, positions));
  });

  // The display composites a preview from two textures: the committed buffer
  // everywhere, and the ping-pong partner inside the per-band bin ranges the
  // preview wrote. So those bins must hold exactly what committing the same
  // dab would, and every pixel the commit changes must lie inside them.
  it("a preview's bin ranges hold a committed dab's result and cover its whole change", async () => {
    const position = new Vector2(0.5, 0.5);
    const makeState = stateFor(["blur"], { brushSizeTime: 0.5, brushSizePitch: 12 });

    const committedRenderer = makeRenderer(false);
    let before: Float32Array;
    let committed: Float32Array;
    try {
      const sourceFile = createSourceFile(committedRenderer, spectrogramData);
      before = await committedRenderer.getFBOData();
      committedRenderer.renderStroke(
        makeStrokeParams(position, spectrogramData, { totalDuration: 4 }),
        makeState(),
        sourceFile,
      );
      committed = await committedRenderer.getFBOData();
    } finally {
      committedRenderer.dispose();
    }

    const previewRenderer = makeRenderer(false);
    try {
      const sourceFile = createSourceFile(previewRenderer, spectrogramData);
      previewRenderer.renderStroke(
        makeStrokeParams(position, spectrogramData, { totalDuration: 4, preview: true }),
        makeState(),
        sourceFile,
      );

      const display = previewRenderer.getPreviewDisplay();
      expect(display.active).toBe(true);
      expect(display.committed).toBe(previewRenderer.getDisplayTexture());

      const previewTarget = previewRenderer["pingPong"] === 0 ? previewRenderer["fbo2"] : previewRenderer["fbo1"];
      expect(previewTarget.texture).toBe(display.preview);
      const { textureWidth, textureHeight, numBands, metadata } = spectrogramData;
      const preview = await readRenderTargetPixelsAsync(gl, previewTarget, 0, 0, textureWidth, textureHeight);
      const binRanges = display.binRanges.image.data as Float32Array;

      const inPreview = new Uint8Array(textureWidth * textureHeight);
      let previewPixels = 0;
      for (let band = 0; band < numBands; band++) {
        const offset = metadata[band * 4];
        for (let bin = binRanges[band * 4]; bin < binRanges[band * 4 + 1]; bin++) {
          inPreview[offset + bin] = 1;
          previewPixels++;
        }
      }
      expect(previewPixels).toBeGreaterThan(0);
      expect(previewPixels).toBeLessThan(textureWidth * textureHeight);

      let maxDiff = 0;
      let changedOutside = 0;
      for (let pixel = 0; pixel < textureWidth * textureHeight; pixel++) {
        for (let c = 0; c < 4; c++) {
          const i = pixel * 4 + c;
          if (inPreview[pixel]) {
            maxDiff = Math.max(maxDiff, Math.abs(preview[i] - committed[i]));
          } else if (committed[i] !== before[i]) {
            changedOutside++;
          }
        }
      }
      expect(maxDiff).toBe(0);
      expect(changedOutside).toBe(0);

      const after = await previewRenderer.getFBOData();
      expect(after).toEqual(before);
    } finally {
      previewRenderer.dispose();
    }
  });
});
