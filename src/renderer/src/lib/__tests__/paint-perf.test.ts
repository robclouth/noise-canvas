import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  RGFormat,
  Vector2,
  WebGLRenderer,
} from "three";
import { describe, expect, it } from "vitest";

import { SpectrogramData, State } from "../../store/types";
import { EffectType } from "../../effects/types";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import { createStepStateView } from "../../store";
import { hasActiveModulatorRouting } from "../../store/modulators";
import { resolveBrushAnchor } from "../utils";
import { EffectsRegistry, SourceFileInfo, StrokeParams, StrokeRenderer, StrokeTextures } from "../stroke-renderer";

// Runtime paint-latency profiler. Times real stroke renders on the actual GPU
// (Playwright -> ANGLE/WebKit on macOS) with a GPU sync per render. Uses the
// constant-Q mock so upper-band over-coverage is reproduced, and sweeps the
// texture size to find where over-coverage actually costs. Scissor stays
// enabled (unlike correctness tests) since over-coverage is under investigation.
// Set VITE_SHADER_DEFINES=ABLATE_BRUSH_REJECT to measure cost without the reject.

function createTextures(data: SpectrogramData) {
  const { packedData, inverseMap, metadata, textureWidth, textureHeight, numBands } = data;

  const packedDataTex = new DataTexture(packedData, textureWidth, textureHeight, RGBAFormat, FloatType);
  packedDataTex.internalFormat = "RGBA32F";
  packedDataTex.minFilter = NearestFilter;
  packedDataTex.magFilter = NearestFilter;
  packedDataTex.wrapS = ClampToEdgeWrapping;
  packedDataTex.wrapT = ClampToEdgeWrapping;
  packedDataTex.needsUpdate = true;

  const originalPackedDataTex = packedDataTex.clone();
  originalPackedDataTex.needsUpdate = true;

  const inverseMapTex = new DataTexture(inverseMap, textureWidth, textureHeight, RGFormat, FloatType);
  inverseMapTex.internalFormat = "RG32F";
  inverseMapTex.minFilter = NearestFilter;
  inverseMapTex.magFilter = NearestFilter;
  inverseMapTex.wrapS = ClampToEdgeWrapping;
  inverseMapTex.wrapT = ClampToEdgeWrapping;
  inverseMapTex.needsUpdate = true;

  const metadataTex = new DataTexture(metadata, numBands, 1, RGBAFormat, FloatType);
  metadataTex.internalFormat = "RGBA32F";
  metadataTex.minFilter = NearestFilter;
  metadataTex.magFilter = NearestFilter;
  metadataTex.wrapS = ClampToEdgeWrapping;
  metadataTex.wrapT = ClampToEdgeWrapping;
  metadataTex.needsUpdate = true;

  return { packedDataTex, originalPackedDataTex, inverseMapTex, metadataTex };
}

function placeholder(): DataTexture {
  const tex = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

function scaleLut(): DataTexture {
  const data = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    data[i * 4] = i / 255;
    data[i * 4 + 1] = i / 255;
    data[i * 4 + 2] = i / 255;
    data[i * 4 + 3] = 1;
  }
  const tex = new DataTexture(data, 256, 1, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return tex;
}

async function loadAllEffects(): Promise<EffectsRegistry> {
  const mods = await Promise.all([
    import("../../effects/passthrough-effect"),
    import("../../effects/transform-effect"),
    import("../../effects/dynamics-effect"),
    import("../../effects/blur-effect"),
    import("../../effects/overtones-effect"),
    import("../../effects/clone-effect"),
    import("../../effects/convolve-effect"),
    import("../../effects/evolve-effect"),
    import("../../effects/binaural-effect"),
    import("../../effects/transmute-effect"),
    import("../../effects/waveshape-effect"),
    import("../../effects/sort-effect"),
    import("../../effects/align-effect"),
    import("../../effects/synthesize-effect"),
  ]);
  const [pt, tr, dy, bl, ov, cl, co, ev, bi, tm, ws, so, al, sy] = mods;
  return {
    passthrough: pt.passThroughEffect,
    transform: tr.transformEffect,
    dynamics: dy.dynamicsEffect,
    blur: bl.blurEffect,
    overtones: ov.overtonesEffect,
    clone: cl.cloneEffect,
    convolve: co.convolveEffect,
    evolve: ev.evolveEffect,
    binaural: bi.binauralEffect,
    transmute: tm.transmuteEffect,
    waveshape: ws.waveshapeEffect,
    sort: so.sortEffect,
    align: al.alignEffect,
    synthesize: sy.synthesizeEffect,
  } as EffectsRegistry;
}

const EFFECT_NAMES = [
  "passthrough",
  "transform",
  "dynamics",
  "blur",
  "overtones",
  "clone",
  "convolve",
  "evolve",
  "binaural",
  "transmute",
  "waveshape",
  "sort",
  "align",
  "synthesize",
] as const;

type Scenario = {
  label: string;
  cursor: Vector2;
  brushSizeTime: number;
  brushSizePitch: number;
};

// cursor.y near 1 = highest-frequency bands (most over-covered); near 0 = lowest.
const SCENARIOS: Scenario[] = [
  { label: "upper-small", cursor: new Vector2(0.2, 0.92), brushSizeTime: 1, brushSizePitch: 3 },
  { label: "lower-small", cursor: new Vector2(0.2, 0.04), brushSizeTime: 1, brushSizePitch: 3 },
  { label: "full", cursor: new Vector2(0, 0), brushSizeTime: 32, brushSizePitch: 128 },
];

const BPM = 120;
const TOTAL_DURATION = 10;

function buildState(effect: EffectType, scenario: Scenario): State {
  const effects = [{ id: `test-${effect}`, effect, enabled: true, params: {} }];
  const state = createMockState({ effects, filepathsBpm: { "/test/perf.wav": BPM } });
  const step = state.brushes[state.activeBrushIndex]?.steps?.[0] as Record<string, unknown> | undefined;
  if (step) {
    step.effects = effects;
    step.brushSizeTime = scenario.brushSizeTime;
    step.brushSizePitch = scenario.brushSizePitch;
  }
  return state;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

type Harness = {
  data: SpectrogramData;
  renderer: StrokeRenderer;
  sourceFile: SourceFileInfo;
  dispose: () => void;
};

function buildHarness(gl: WebGLRenderer, effects: EffectsRegistry, data: SpectrogramData): Harness {
  const tex = createTextures(data);
  const ph = placeholder();
  const lut = scaleLut();
  const strokeTextures: StrokeTextures = {
    packedDataTex: tex.packedDataTex,
    originalPackedDataTex: tex.originalPackedDataTex,
    inverseMapTex: tex.inverseMapTex,
    metadataTex: tex.metadataTex,
    placeholderTexture: ph,
    modulatorScaleLut: lut,
    modulator1Texture: ph,
    modulator2Texture: ph,
    modulator3Texture: ph,
  };
  const renderer = new StrokeRenderer(gl, data, strokeTextures, "perf", effects);
  renderer.initialize();
  const st = renderer.getTextures();
  const sourceFile: SourceFileInfo = {
    id: "perf",
    filePath: "/test/perf.wav",
    displayName: "perf.wav",
    spectrogramData: data,
    textures: { packed: st.packed, inverse: st.inverse, metadata: st.metadata, original: st.original },
  };
  const dispose = () => {
    renderer.dispose();
    tex.packedDataTex.dispose();
    tex.originalPackedDataTex.dispose();
    tex.inverseMapTex.dispose();
    tex.metadataTex.dispose();
    ph.dispose();
    lut.dispose();
  };
  return { data, renderer, sourceFile, dispose };
}

function paramsFor(scenario: Scenario): StrokeParams {
  return {
    cursorPos: scenario.cursor,
    preview: false,
    bpm: BPM,
    totalDuration: TOTAL_DURATION,
    viewZoomPower: 0,
    viewOffset: 0,
    viewZoomPowerY: 0,
    viewOffsetY: 0,
    pressure: 0,
    tiltX: 0,
    tiltY: 0,
  };
}

function timeRender(h: Harness, effect: EffectType, scenario: Scenario): number {
  const state = buildState(effect, scenario);
  const params = paramsFor(scenario);
  for (let i = 0; i < 3; i++) h.renderer.renderStroke(params, state, h.sourceFile);
  h.renderer.finishGpu();
  const samples: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    h.renderer.renderStroke(params, state, h.sourceFile);
    h.renderer.finishGpu();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

function fragCount(h: Harness, scenario: Scenario): number {
  const fp = h.renderer.resolveBrushFootprint(buildState("passthrough", scenario), BPM, TOTAL_DURATION);
  const anchor = resolveBrushAnchor(scenario.cursor, fp.fullTime, fp.fullPitch);
  const rows = h.renderer.calculateScissorRows(anchor, fp.sizeUv);
  return rows ? rows.rowCount * h.data.textureWidth : h.data.textureWidth * h.data.textureHeight;
}

const defines = (import.meta.env.VITE_SHADER_DEFINES as string | undefined) ?? "none";

// Opt-in: this is a profiler, not a correctness test. Run with
// VITE_PAINT_PROFILE=1 so it stays out of the normal suite.
const RUN_PROFILE = Boolean(import.meta.env.VITE_PAINT_PROFILE);

describe.skipIf(!RUN_PROFILE)("paint perf profile", () => {
  it("sweeps texture size for passthrough to isolate over-coverage", async () => {
    const effects = await loadAllEffects();
    const gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    const renderer = gl.getContext().getParameter(gl.getContext().RENDERER);

    const durations = [2, 5, 10];
    let out = `\n=== Passthrough duration sweep, bpo 12 (median ms) [defines: ${defines}] | GL: ${renderer} ===\n`;
    out += `${"seconds".padEnd(8)} ${"texW".padStart(6)} ${"texH".padStart(6)} ${SCENARIOS.map((s) => s.label.padStart(12)).join(" ")}\n`;

    for (const durationSeconds of durations) {
      const data = createConstantQMockSpectrogramData({ durationSeconds, bandsPerOctave: 12 });
      const h = buildHarness(gl, effects, data);
      const cells = SCENARIOS.map((s) => {
        const ms = timeRender(h, "passthrough", s);
        const frags = fragCount(h, s);
        return `${ms.toFixed(2)}/${(frags / 1000).toFixed(0)}k`.padStart(12);
      });
      out += `${String(durationSeconds).padEnd(8)} ${String(data.textureWidth).padStart(6)} ${String(data.textureHeight).padStart(6)} ${cells.join(" ")}\n`;
      h.dispose();
    }
    out += `(cell = ms / scissor-fragment-count)\n`;
    console.log(out);

    gl.dispose();
    expect(durations.length).toBe(3);
  }, 600000);

  it("times every effect at a large texture", async () => {
    const effects = await loadAllEffects();
    const gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    const data = createConstantQMockSpectrogramData({ durationSeconds: 10, bandsPerOctave: 12 });
    const h = buildHarness(gl, effects, data);

    const rows: { effect: string; cells: number[] }[] = [];
    for (const effect of EFFECT_NAMES) {
      rows.push({ effect, cells: SCENARIOS.map((s) => timeRender(h, effect, s)) });
    }

    const renderer = gl.getContext().getParameter(gl.getContext().RENDERER);
    let out = `\n=== Per-effect latency at topFrames=131072 (median ms) [defines: ${defines}] | GL: ${renderer} ===\n`;
    out += `${"effect".padEnd(12)} ${SCENARIOS.map((s) => s.label.padStart(12)).join(" ")}\n`;
    for (const r of rows) {
      out += `${r.effect.padEnd(12)} ${r.cells.map((c) => c.toFixed(2).padStart(12)).join(" ")}\n`;
    }
    out += `\n${"frags".padEnd(12)} ${SCENARIOS.map((s) => `${(fragCount(h, s) / 1000).toFixed(0)}k`.padStart(12)).join(" ")}\n`;
    console.log(out);

    h.dispose();
    gl.dispose();
    expect(rows.length).toBe(EFFECT_NAMES.length);
  }, 600000);

  it("measures the cost of active modulation", async () => {
    const effects = await loadAllEffects();
    const gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
    const data = createConstantQMockSpectrogramData({ durationSeconds: 10, bandsPerOctave: 12 });
    const h = buildHarness(gl, effects, data);

    // Build a state that routes brush intensity to a Sine pattern modulator,
    // setting the amount on BOTH the state and the active step so the per-step
    // state view can't reset it to its default of zero. Returns whether the
    // routing is actually live so the table can't silently report unmodulated
    // numbers as modulated.
    const buildModState = (effect: EffectType, scenario: Scenario, modulated: boolean): State => {
      const state = buildState(effect, scenario) as unknown as Record<string, unknown>;
      if (modulated) {
        state.modulator1Mode = 0; // Pattern
        state.modulator1PatternShape = 0; // Sine
        state.brushIntensityMod1Amount = 100;
        const brushes = state.brushes as { steps?: Record<string, unknown>[] }[];
        const step = brushes[state.activeBrushIndex as number]?.steps?.[0];
        if (step) step.brushIntensityMod1Amount = 100;
      }
      return state as unknown as State;
    };

    // Per-render timings (with a GPU sync each) so we can see mean vs max — a
    // mean far above the max-of-most reveals periodic spikes (accumulation),
    // versus a steady high cost.
    const timeModed = (effect: EffectType, scenario: Scenario, modulated: boolean): { mean: number; max: number } => {
      const state = buildModState(effect, scenario, modulated);
      const params = paramsFor(scenario);
      for (let i = 0; i < 5; i++) h.renderer.renderStroke(params, state, h.sourceFile);
      h.renderer.finishGpu();
      const samples: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now();
        h.renderer.renderStroke(params, state, h.sourceFile);
        h.renderer.finishGpu();
        samples.push(performance.now() - t0);
      }
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      return { mean, max: Math.max(...samples) };
    };
    const fmtCell = (c: { mean: number; max: number }) => `${c.mean.toFixed(1)}/${c.max.toFixed(0)}`.padStart(16);

    // Confirm the modulated state actually engages the precompute pass.
    const engaged = hasActiveModulatorRouting(createStepStateView(buildModState("synthesize", SCENARIOS[0], true), 0));

    const modEffects: EffectType[] = ["passthrough", "synthesize", "blur"];
    const modScenarios = SCENARIOS.filter((s) => s.label === "upper-small" || s.label === "full");

    const ctx = gl.getContext();
    const dbg = ctx.getExtension("WEBGL_debug_renderer_info");
    const unmasked = dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "n/a";
    let out = `\n=== Sine-modulated brush intensity vs unmodulated (mean ms/render) [defines: ${defines}] ===\n`;
    out += `GPU (unmasked): ${unmasked}\n`;
    out += `texture: ${h.data.textureWidth}x${h.data.textureHeight} (${((h.data.textureWidth * h.data.textureHeight) / 1e6).toFixed(1)}M px), numFrames=${h.data.numFrames}, numBands=${h.data.numBands}\n`;
    out += `modulation actually engaged: ${engaged}\n`;
    out += `cells are mean/max ms per render\n`;
    out += `${"effect".padEnd(12)} ${modScenarios.map((s) => `${s.label} off`.padStart(16)).join(" ")} ${modScenarios.map((s) => `${s.label} SINE`.padStart(16)).join(" ")}\n`;
    for (const effect of modEffects) {
      const off = modScenarios.map((s) => fmtCell(timeModed(effect, s, false)));
      const on = modScenarios.map((s) => fmtCell(timeModed(effect, s, true)));
      out += `${effect.padEnd(12)} ${off.join(" ")} ${on.join(" ")}\n`;
    }
    console.log(out);

    h.dispose();
    gl.dispose();
    expect(engaged).toBe(true);
  }, 600000);
});
