import { describe, expect, it, vi } from "vitest";

// Mock all problematic imports BEFORE any other imports
vi.mock("@renderer/effects", () => ({
  effects: {
    transform: {},
    dynamics: {},
    blur: {},
    overtones: {},
    synthesize: {},
    passthrough: {},
  },
}));

vi.mock("@renderer/lib/factory-presets", () => ({
  factoryPresets: [],
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

vi.mock("@renderer/lib/folders", () => ({
  getFolders: vi.fn().mockResolvedValue({ presetsDir: "/mock/presets" }),
}));

// Mock the store index to break circular dependency
vi.mock("@renderer/store", () => ({
  useStore: { getState: vi.fn() },
}));

// Now import the actual code we want to test
import { createPresetsSlice } from "../../store/presets";
import { createDefaultStep, BrushStep } from "../../parameters";
import type { State } from "../../store/types";

/**
 * Helper to create a step with custom values.
 */
function createStep(name: string, overrides: Record<string, unknown> = {}): BrushStep {
  const step = createDefaultStep(name);
  return Object.assign(step, overrides);
}

/**
 * Creates a minimal mock state for testing with slots architecture.
 */
function createMockState(overrides: Partial<State> = {}): State {
  const defaultStep = createDefaultStep("Step 1");

  const baseState: Partial<State> = {
    slots: { 0: [defaultStep] },
    activeSlotIndex: 0,
    activeStepIndex: 0,
    displayMinDb: -60,
    displayMaxDb: 0,
  };

  return { ...baseState, ...overrides } as State;
}

/**
 * Creates a test presets slice with the actual implementation.
 */
function createTestStore(initialState: Partial<State> = {}) {
  const mockState = createMockState(initialState);

  // Preserve the initial slots and activeSlotIndex, don't let slice defaults override them
  const preservedSlots = mockState.slots;
  const preservedActiveSlotIndex = mockState.activeSlotIndex;

  let state = mockState;

  const get = () => state;
  const set = (partial: Partial<State> | ((s: State) => Partial<State>)) => {
    if (typeof partial === "function") {
      state = { ...state, ...partial(state) } as State;
    } else {
      state = { ...state, ...partial } as State;
    }
  };

  const slice = createPresetsSlice(set, get);
  // Merge slice but preserve initial slots and activeSlotIndex from test setup
  state = {
    ...state,
    ...slice,
    slots: preservedSlots,
    activeSlotIndex: preservedActiveSlotIndex,
  } as State;

  return {
    captureState: slice.captureState,
    loadPreset: slice.loadPreset,
    getState: () => state,
    setState: (updates: Partial<State>) => {
      state = { ...state, ...updates } as State;
    },
  };
}

describe("Preset captureState with slots", () => {
  describe("captureState", () => {
    it("should return BrushStep[] array from active slot", () => {
      const step1 = createStep("Test Step 1");
      const step2 = createStep("Test Step 2", { brushIntensity: 75 });

      const store = createTestStore({
        slots: { 0: [step1, step2] },
        activeSlotIndex: 0,
      });

      const captured = store.captureState();

      expect(Array.isArray(captured)).toBe(true);
      expect(captured).toHaveLength(2);
    });

    it("should preserve all step data", () => {
      const step1 = createStep("Step A", { brushIntensity: 50, brushIterations: 3 });
      const step2 = createStep("Step B", { brushIntensity: 100, brushIterations: 5 });

      const store = createTestStore({
        slots: { 0: [step1, step2] },
        activeSlotIndex: 0,
      });
      const captured = store.captureState();

      expect(captured).toHaveLength(2);
      expect(captured[0].name).toBe("Step A");
      expect(captured[0].brushIntensity).toBe(50);
      expect(captured[0].brushIterations).toBe(3);
      expect(captured[1].name).toBe("Step B");
      expect(captured[1].brushIntensity).toBe(100);
      expect(captured[1].brushIterations).toBe(5);
    });

    it("should preserve step IDs", () => {
      const step = createStep("My Step");
      const originalId = step.id;

      const store = createTestStore({
        slots: { 0: [step] },
        activeSlotIndex: 0,
      });
      const captured = store.captureState();

      expect(captured[0].id).toBe(originalId);
    });

    it("should capture from the active slot", () => {
      const slot0Step = createStep("Slot 0 Step", { brushIntensity: 25 });
      const slot1Step = createStep("Slot 1 Step", { brushIntensity: 75 });

      const store = createTestStore({
        slots: {
          0: [slot0Step],
          1: [slot1Step],
        },
        activeSlotIndex: 1,
      });

      const captured = store.captureState();

      expect(captured).toHaveLength(1);
      expect(captured[0].name).toBe("Slot 1 Step");
      expect(captured[0].brushIntensity).toBe(75);
    });

    it("should return default step when active slot is empty", () => {
      const store = createTestStore({
        slots: {},
        activeSlotIndex: 0,
      });

      const captured = store.captureState();

      expect(captured).toHaveLength(1);
      expect(captured[0].name).toBe("Step 1");
    });
  });

  describe("preset schema compatibility", () => {
    it("captured state should be usable directly as preset.steps", () => {
      const step = createStep("Test", { brushIntensity: 50 });

      const store = createTestStore({
        slots: { 0: [step] },
        activeSlotIndex: 0,
      });

      const captured = store.captureState();

      // This is exactly how savePreset builds the preset
      const preset = {
        id: "test-preset",
        name: "Test Preset",
        isFactory: false,
        version: 3,
        steps: captured,
      };

      expect(preset.steps).toHaveLength(1);
      expect(preset.steps[0].brushIntensity).toBe(50);
      expect(preset.steps[0].name).toBe("Test");
    });
  });
});
