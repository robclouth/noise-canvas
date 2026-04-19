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
import { BrushStep, createDefaultStep, parameterDefs } from "../../parameters";
import { createPresetsSlice } from "../../store/presets";
import type { Brush, State } from "../../store/types";
import { CURRENT_PRESET_VERSION, validatePreset } from "../preset-schema";

/**
 * Helper to create a step with custom values.
 */
function createStep(name: string, overrides: Record<string, unknown> = {}): BrushStep {
  const step = createDefaultStep(name);
  return Object.assign(step, overrides);
}

function makeBrush(steps: BrushStep[], name = "Mock"): Brush {
  return {
    id: crypto.randomUUID(),
    name,
    color: { hue: "orange", variation: 0 },
    hotkey: null,
    steps,
    linkedParams: [],
    libraryId: null,
    macroNames: ["Macro 1", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [50, 50, 50, 50],
  };
}

/**
 * Creates a minimal mock state for testing with brushes architecture.
 */
function createMockState(overrides: Partial<State> = {}): State {
  const defaultStep = createDefaultStep("Step 1");

  const baseState: Partial<State> = {
    brushes: [makeBrush([defaultStep])],
    activeBrushIndex: 0,
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

  const preservedBrushes = mockState.brushes;
  const preservedActiveBrushIndex = mockState.activeBrushIndex;

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
  state = {
    ...state,
    ...slice,
    brushes: preservedBrushes,
    activeBrushIndex: preservedActiveBrushIndex,
  } as State;

  return {
    captureState: slice.captureState,
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
        brushes: [makeBrush([step1, step2])],
        activeBrushIndex: 0,
      });

      const captured = store.captureState();

      expect(Array.isArray(captured)).toBe(true);
      expect(captured).toHaveLength(2);
    });

    it("should preserve all step data", () => {
      const step1 = createStep("Step A", { brushIntensity: 50, brushIterations: 3 });
      const step2 = createStep("Step B", { brushIntensity: 100, brushIterations: 5 });

      const store = createTestStore({
        brushes: [makeBrush([step1, step2])],
        activeBrushIndex: 0,
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
        brushes: [makeBrush([step])],
        activeBrushIndex: 0,
      });
      const captured = store.captureState();

      expect(captured[0].id).toBe(originalId);
    });

    it("should capture from the active brush", () => {
      const brush0Step = createStep("Brush 0 Step", { brushIntensity: 25 });
      const brush1Step = createStep("Brush 1 Step", { brushIntensity: 75 });

      const store = createTestStore({
        brushes: [makeBrush([brush0Step]), makeBrush([brush1Step])],
        activeBrushIndex: 1,
      });

      const captured = store.captureState();

      expect(captured).toHaveLength(1);
      expect(captured[0].name).toBe("Brush 1 Step");
      expect(captured[0].brushIntensity).toBe(75);
    });

    it("should return default step when active brush is empty", () => {
      const store = createTestStore({
        brushes: [makeBrush([])],
        activeBrushIndex: 0,
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
        brushes: [makeBrush([step])],
        activeBrushIndex: 0,
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

  describe("save -> reload round trip", () => {
    /**
     * Build a preset the same way savePreset does. This is the shape that hits disk.
     */
    function buildPreset(steps: BrushStep[]) {
      return {
        id: "round-trip-preset",
        name: "Round Trip",
        isFactory: false,
        version: CURRENT_PRESET_VERSION,
        steps,
        linkedParams: [],
      };
    }

    /**
     * Simulate the full trip: serialize to JSON (as writeFile does), parse back
     * (as init does on startup), then validate.
     */
    function roundTrip(preset: ReturnType<typeof buildPreset>) {
      const serialized = JSON.stringify(preset);
      const parsed = JSON.parse(serialized);
      return validatePreset(parsed);
    }

    it("validates a preset containing every default step parameter", () => {
      // createDefaultStep assigns defaults for every includeInStep parameter,
      // so this catches any parameter kind the schema doesn't handle.
      const preset = buildPreset([createDefaultStep("Step 1")]);

      const result = roundTrip(preset);

      if (!result.success) {
        throw new Error(`Round-trip validation failed: ${result.errors.join(", ")}`);
      }
      expect(result.success).toBe(true);
    });

    it("validates a preset with sourceFile set (file kind parameter)", () => {
      const step = createDefaultStep("Step 1");
      step.sourceFile = { path: "/tmp/source.wav" };
      const preset = buildPreset([step]);

      const result = roundTrip(preset);

      if (!result.success) {
        throw new Error(`sourceFile round-trip failed: ${result.errors.join(", ")}`);
      }
      expect(result.success).toBe(true);
    });

    it("validates a preset with sourceFile explicitly null", () => {
      const step = createDefaultStep("Step 1");
      step.sourceFile = null;
      const preset = buildPreset([step]);

      const result = roundTrip(preset);

      expect(result.success).toBe(true);
    });

    it("every includeInStep parameter kind has a schema handler", () => {
      // If a new parameter kind is added without updating createStepParametersSchema,
      // the default value will either be rejected by the strict object or stripped
      // silently. This test fails loudly either way by checking the kind against the
      // set of kinds the schema knows how to handle.
      const SUPPORTED_KINDS = new Set(["number", "boolean", "options", "string", "file"]);

      const unsupported: Array<{ key: string; kind: string }> = [];
      for (const [key, def] of Object.entries(parameterDefs)) {
        if (def?.includeInStep && !SUPPORTED_KINDS.has(def.kind)) {
          unsupported.push({ key, kind: def.kind });
        }
      }

      if (unsupported.length > 0) {
        throw new Error(
          `Parameters with unsupported kinds in preset schema: ${unsupported
            .map(({ key, kind }) => `${key} (${kind})`)
            .join(", ")}. Add a case in createStepParametersSchema.`,
        );
      }
    });
  });
});
