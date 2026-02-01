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
 * Creates a minimal mock state for testing.
 */
function createMockState(overrides: Partial<State> = {}): State {
  const defaultStep = createDefaultStep("Step 1");

  const baseState: Partial<State> = {
    steps: [defaultStep],
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
  let state = createMockState(initialState);

  const get = () => state;
  const set = (partial: Partial<State> | ((s: State) => Partial<State>)) => {
    if (typeof partial === "function") {
      state = { ...state, ...partial(state) } as State;
    } else {
      state = { ...state, ...partial } as State;
    }
  };

  const slice = createPresetsSlice(set, get);
  state = { ...state, ...slice } as State;

  return {
    captureState: slice.captureState,
    recallState: slice.recallState,
    getState: () => state,
    setState: (updates: Partial<State>) => {
      state = { ...state, ...updates } as State;
    },
  };
}

describe("Preset captureState/recallState", () => {
  describe("captureState", () => {
    it("should return BrushStep[] array directly", () => {
      const step1 = createStep("Test Step 1");
      const step2 = createStep("Test Step 2", { brushIntensity: 75 });

      const store = createTestStore({
        steps: [step1, step2],
      });

      const captured = store.captureState();

      expect(Array.isArray(captured)).toBe(true);
      expect(captured).toHaveLength(2);
    });

    it("should preserve all step data", () => {
      const step1 = createStep("Step A", { brushIntensity: 50, brushIterations: 3 });
      const step2 = createStep("Step B", { brushIntensity: 100, brushIterations: 5 });

      const store = createTestStore({ steps: [step1, step2] });
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

      const store = createTestStore({ steps: [step] });
      const captured = store.captureState();

      expect(captured[0].id).toBe(originalId);
    });
  });

  describe("recallState", () => {
    it("should restore steps from captured state", () => {
      const step1 = createStep("Restored Step 1", { brushIntensity: 42 });
      const step2 = createStep("Restored Step 2", { brushIntensity: 84 });

      const store = createTestStore({
        steps: [createStep("Current Step")],
      });

      const updates = store.recallState([step1, step2]);

      expect(updates.steps).toHaveLength(2);
      expect(updates.steps![0].name).toBe("Restored Step 1");
      expect(updates.steps![0].brushIntensity).toBe(42);
      expect(updates.steps![1].name).toBe("Restored Step 2");
      expect(updates.steps![1].brushIntensity).toBe(84);
      expect(updates.activeStepIndex).toBe(0);
    });

    it("should create default step when steps array is empty", () => {
      const store = createTestStore({
        steps: [createStep("Current")],
      });

      const updates = store.recallState([]);

      expect(updates.steps).toHaveLength(1);
      expect(updates.steps![0].name).toBe("Step 1");
    });

    it("should merge preset steps with default values", () => {
      // Create a minimal step that's missing some parameters
      const minimalStep = {
        id: "test-id",
        name: "Minimal Step",
        brushIntensity: 50,
      } as unknown as BrushStep;

      const store = createTestStore();
      const updates = store.recallState([minimalStep]);

      // Should have the specified values
      expect(updates.steps![0].brushIntensity).toBe(50);
      // Should have default values for missing params
      expect(updates.steps![0].brushIterations).toBeDefined();
    });

    it("should preserve step IDs from captured state", () => {
      const step = createStep("My Step");
      const originalId = step.id;

      const store = createTestStore();
      const updates = store.recallState([step]);

      expect(updates.steps![0].id).toBe(originalId);
    });
  });

  describe("round-trip captureState → recallState", () => {
    it("should preserve all step data through capture and recall", () => {
      const step1 = createStep("My Step 1", { brushIntensity: 25, brushIterations: 2 });
      const step2 = createStep("My Step 2", { brushIntensity: 75, brushIterations: 4 });

      const store = createTestStore({
        steps: [step1, step2],
      });

      // Capture
      const captured = store.captureState();

      // Create new store and recall
      const newStore = createTestStore({
        steps: [createStep("Default")],
      });

      const updates = newStore.recallState(captured);

      // Verify steps restored
      expect(updates.steps).toHaveLength(2);
      expect(updates.steps![0].name).toBe("My Step 1");
      expect(updates.steps![0].brushIntensity).toBe(25);
      expect(updates.steps![0].brushIterations).toBe(2);
      expect(updates.steps![1].name).toBe("My Step 2");
      expect(updates.steps![1].brushIntensity).toBe(75);
      expect(updates.steps![1].brushIterations).toBe(4);
    });

    it("should preserve step IDs through round-trip", () => {
      const step = createStep("My Step");
      const originalId = step.id;

      const store = createTestStore({ steps: [step] });
      const captured = store.captureState();

      const newStore = createTestStore();
      const updates = newStore.recallState(captured);

      expect(updates.steps![0].id).toBe(originalId);
    });
  });

  describe("preset schema compatibility", () => {
    it("captured state should be usable directly as preset.steps", () => {
      const step = createStep("Test", { brushIntensity: 50 });

      const store = createTestStore({
        steps: [step],
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
