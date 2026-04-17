// Use type-only import to avoid triggering module execution and circular dependencies
import type { State } from "../store/types";
import type { BrushStep } from "../parameters";

/**
 * Type for a brush step in tests.
 */
export interface TestBrushStep {
  id: string;
  name: string;
  brushIntensity?: number;
  brushIterations?: number;
  brushPan?: number;
  brushEnvelopeDelayTime?: number;
  brushEnvelopeAttackTime?: number;
  brushEnvelopeSustainTime?: number;
  brushEnvelopeReleaseTime?: number;
  brushEnvelopeDelayPitch?: number;
  brushEnvelopeAttackPitch?: number;
  brushEnvelopeSustainPitch?: number;
  brushEnvelopeReleasePitch?: number;
  brushWrapMode?: number;
  blendMode?: number;
  algorithm?: number;
  sourceDataMode?: string;
  accumulate?: boolean;
  effects?: Array<{ id: string; effect: string; enabled: boolean; params: Record<string, unknown> }>;
  [key: string]: unknown;
}

/**
 * Creates a default test step without importing from parameters.
 */
function createTestStep(name: string): TestBrushStep {
  return {
    id: crypto.randomUUID(),
    name,
    brushIntensity: 100,
    brushIterations: 1,
    brushPan: 0,
    brushEnvelopeDelayTime: 0,
    brushEnvelopeAttackTime: 0.25,
    brushEnvelopeSustainTime: 0.5,
    brushEnvelopeReleaseTime: 0.25,
    brushEnvelopeDelayPitch: 0,
    brushEnvelopeAttackPitch: 3,
    brushEnvelopeSustainPitch: 6,
    brushEnvelopeReleasePitch: 3,
    brushWrapMode: 0,
    blendMode: 0,
    algorithm: 0,
    sourceDataMode: "current",
    accumulate: false,
    effects: [
      { id: "mock-transform", effect: "transform", enabled: true, params: {} },
      { id: "mock-dynamics", effect: "dynamics", enabled: false, params: {} },
      { id: "mock-blur", effect: "blur", enabled: false, params: {} },
      { id: "mock-overtones", effect: "overtones", enabled: false, params: {} },
      { id: "mock-synthesize", effect: "synthesize", enabled: false, params: {} },
    ],
  };
}

/**
 * Creates a minimal mock state for testing stroke rendering.
 * Only includes the properties needed by StrokeRenderer.
 */
export function createMockState(overrides: Partial<State> = {}): State {
  const defaultStep = createTestStep("Test Step 1");

  // Create a minimal state with defaults for stroke rendering
  // Use type assertion to allow test-specific properties
  const baseState = {
    // Brushes - source of truth for brush parameters
    brushes: [
      {
        id: "mock-brush-0",
        name: "Mock",
        color: { hue: "orange", variation: 0 },
        hotkey: null,
        steps: [defaultStep] as unknown as BrushStep[],
        linkedParams: [],
        libraryId: null,
      },
    ],
    activeBrushIndex: 0,
    activeStepIndex: 0,

    // Brush parameters (from step or global)
    brushIntensity: 100,
    brushIterations: 1,
    brushPan: 0,
    brushEnvelopeDelayTime: 0,
    brushEnvelopeAttackTime: 0.25,
    brushEnvelopeSustainTime: 0.5,
    brushEnvelopeReleaseTime: 0.25,
    brushEnvelopeDelayPitch: 0,
    brushEnvelopeAttackPitch: 3,
    brushEnvelopeSustainPitch: 6,
    brushEnvelopeReleasePitch: 3,
    brushWrapMode: 0,
    blendMode: 0,
    algorithm: 0,

    // Source
    sourceFile: null,
    sourcePositionMode: "fixed",
    sourceDataMode: "current",
    cursorPosition: null,

    // Effects
    effects: [
      { id: "mock-transform", effect: "transform", enabled: true, params: {} },
      { id: "mock-dynamics", effect: "dynamics", enabled: false, params: {} },
      { id: "mock-blur", effect: "blur", enabled: false, params: {} },
      { id: "mock-overtones", effect: "overtones", enabled: false, params: {} },
      { id: "mock-synthesize", effect: "synthesize", enabled: false, params: {} },
    ],

    // Modulators (minimal)
    modulator1Mode: 0,
    modulator1Strength: 100,
    modulator1PatternRateBeats: 1,
    modulator1PatternRateSemis: 12,
    modulator1PatternShape: 0,
    modulator1PhaseMode: 0,
    modulator1Rotation: 0,
    modulator1EnvelopeMinDb: -60,
    modulator1EnvelopeMaxDb: 0,
    modulator1SeqStepsX: 4,
    modulator1SeqStepsY: 1,
    modulator1SeqLoopBeats: 4,
    modulator1SeqLoopSemis: 12,
    modulator1SeqSwing: 0,

    modulator2Mode: 0,
    modulator2Strength: 100,
    modulator2PatternRateBeats: 1,
    modulator2PatternRateSemis: 12,
    modulator2PatternShape: 0,
    modulator2PhaseMode: 0,
    modulator2Rotation: 0,
    modulator2EnvelopeMinDb: -60,
    modulator2EnvelopeMaxDb: 0,
    modulator2SeqStepsX: 4,
    modulator2SeqStepsY: 1,
    modulator2SeqLoopBeats: 4,
    modulator2SeqLoopSemis: 12,
    modulator2SeqSwing: 0,

    modulator3Mode: 0,
    modulator3Strength: 100,
    modulator3PatternRateBeats: 1,
    modulator3PatternRateSemis: 12,
    modulator3PatternShape: 0,
    modulator3PhaseMode: 0,
    modulator3Rotation: 0,
    modulator3EnvelopeMinDb: -60,
    modulator3EnvelopeMaxDb: 0,
    modulator3SeqStepsX: 4,
    modulator3SeqStepsY: 1,
    modulator3SeqLoopBeats: 4,
    modulator3SeqLoopSemis: 12,
    modulator3SeqSwing: 0,

    // Modulation amounts (all zeros by default)
    brushIntensityModAmount1: 0,
    brushIntensityModAmount2: 0,
    brushIntensityModAmount3: 0,
    brushIntensityContextModAmountIteration: 0,
    brushIntensityContextModAmountStep: 0,
    brushIntensityContextModAmountTime: 0,
    brushIntensityContextModAmountPitch: 0,
    brushIntensityContextModAmountRandom: 0,

    brushPanModAmount1: 0,
    brushPanModAmount2: 0,
    brushPanModAmount3: 0,
    brushPanContextModAmountIteration: 0,
    brushPanContextModAmountStep: 0,
    brushPanContextModAmountTime: 0,
    brushPanContextModAmountPitch: 0,
    brushPanContextModAmountRandom: 0,

    // Effects parameters (minimal defaults)
    transformShiftBeats: 0,
    transformShiftSemis: 0,
    transformScaleX: 1,
    transformScaleY: 1,
    transformRotation: 0,

    dynamicsThresholdDb: -20,
    dynamicsUpperRatio: 1,
    dynamicsLowerRatio: 1,
    dynamicsKnee: 6,
    dynamicsGainDb: 0,

    blurAmountBeats: 0.25,
    blurAmountSemis: 3,
    blurIterations: 1,

    overtonesCount: 8,
    overtonesShape: "octaves",
    overtonesGain: -6,
    overtonesDecay: -3,

    synthesizeType: "noise",
    synthesizeGain: 0,

    // Global settings
    magnitudeLimit: 1.0,

    // Display (not used in stroke rendering but may be accessed)
    displayMinDb: -60,
    displayMaxDb: 0,
    gridSizeBeats: 1,
    gridSizeSemis: 12,
  };

  // Merge overrides
  return { ...baseState, ...overrides } as State;
}

/**
 * Creates a mock step with overrides.
 */
export function createMockStep(name: string, overrides: Partial<TestBrushStep> = {}): TestBrushStep {
  const step = createTestStep(name);
  return { ...step, ...overrides };
}

/**
 * Creates a state with multiple steps for testing multi-step behavior.
 */
export function createMockStateWithSteps(
  stepConfigs: Array<{ name: string; overrides?: Partial<TestBrushStep> }>,
  stateOverrides: Partial<State> = {}
): State {
  const steps = stepConfigs.map(({ name, overrides }) => createMockStep(name, overrides));

  return createMockState({
    brushes: [
      {
        id: "mock-brush-0",
        name: "Mock",
        color: { hue: "orange", variation: 0 },
        hotkey: null,
        steps: steps as unknown as BrushStep[],
        linkedParams: [],
        libraryId: null,
      },
    ],
    activeBrushIndex: 0,
    activeStepIndex: 0,
    ...stateOverrides,
  });
}

/**
 * Creates a state configured for iteration testing.
 */
export function createMockStateForIterations(
  iterations: number,
  stateOverrides: Partial<State> = {},
  stepOverrides: Partial<TestBrushStep> = {}
): State {
  const step = createMockStep("Iteration Test Step", {
    brushIterations: iterations,
    ...stepOverrides,
  });

  return createMockState({
    brushes: [
      {
        id: "mock-brush-0",
        name: "Mock",
        color: { hue: "orange", variation: 0 },
        hotkey: null,
        steps: [step] as unknown as BrushStep[],
        linkedParams: [],
        libraryId: null,
      },
    ],
    activeBrushIndex: 0,
    ...stateOverrides,
  });
}
