import { BrushStep, createDefaultStep, isStepParameter } from "@renderer/parameters";
import { produce } from "immer";
import type { ParameterKey, ZustandGet, ZustandSet } from "./types";

export const MAX_STEPS = 10;

export const STEPS_PERSISTED_KEYS = ["steps", "activeStepIndex"] as const;

export interface StepsState {
  steps: BrushStep[];
  activeStepIndex: number;
  setActiveStepIndex: (index: number) => void;
  addStep: () => void;
  removeStep: (index: number) => void;
  duplicateStep: (index: number) => void;
  reorderSteps: (from: number, to: number) => void;
  getActiveStep: () => BrushStep;
  setStepParameter: (key: ParameterKey, value: any) => void;
  setStepName: (index: number, name: string) => void;
}

export const createStepsSlice = (set: ZustandSet, get: ZustandGet): StepsState => ({
  steps: [createDefaultStep("Step 1")],
  activeStepIndex: 0,

  setActiveStepIndex: (index: number) => {
    const { steps } = get();
    if (index >= 0 && index < steps.length) {
      set({ activeStepIndex: index });
    }
  },

  addStep: () => {
    const state = get();
    if (state.steps.length >= MAX_STEPS) return;

    set(
      produce((draft: StepsState) => {
        const nextStepNumber = draft.steps.length + 1;
        const newStep = createDefaultStep(`Step ${nextStepNumber}`);
        draft.steps.push(newStep);
        draft.activeStepIndex = draft.steps.length - 1;
      }),
    );
  },

  removeStep: (index: number) => {
    const state = get();
    if (state.steps.length <= 1) return;
    if (index < 0 || index >= state.steps.length) return;

    set(
      produce((draft: StepsState) => {
        draft.steps.splice(index, 1);
        // Adjust activeStepIndex if needed
        if (draft.activeStepIndex >= draft.steps.length) {
          draft.activeStepIndex = draft.steps.length - 1;
        } else if (draft.activeStepIndex > index) {
          draft.activeStepIndex--;
        }
      }),
    );
  },

  duplicateStep: (index: number) => {
    const state = get();
    if (state.steps.length >= MAX_STEPS) return;
    if (index < 0 || index >= state.steps.length) return;

    set(
      produce((draft: StepsState) => {
        const stepToDuplicate = draft.steps[index];
        const newStep = { ...stepToDuplicate, id: crypto.randomUUID() };
        draft.steps.splice(index + 1, 0, newStep);
        draft.activeStepIndex = index + 1;
      }),
    );
  },

  reorderSteps: (fromIndex: number, toIndex: number) => {
    set(
      produce((draft: StepsState) => {
        const activeStep = draft.steps[draft.activeStepIndex];
        const [movedStep] = draft.steps.splice(fromIndex, 1);
        draft.steps.splice(toIndex, 0, movedStep);

        // Update active step index to point to the same step object
        draft.activeStepIndex = draft.steps.indexOf(activeStep);
      }),
    );
  },

  getActiveStep: () => {
    const { steps, activeStepIndex } = get();
    return steps[activeStepIndex] || steps[0];
  },

  setStepParameter: (key: ParameterKey, value: any) => {
    if (!isStepParameter(key)) return;

    set(
      produce((draft: StepsState) => {
        if (draft.steps[draft.activeStepIndex]) {
          draft.steps[draft.activeStepIndex][key] = value;
        }
      }),
    );
  },

  setStepName: (index: number, name: string) => {
    set(
      produce((draft: StepsState) => {
        if (draft.steps[index]) {
          draft.steps[index].name = name;
        }
      }),
    );
  },
});

/** Get a step parameter value from a specific step */
export const getStepParameterValue = (steps: BrushStep[], stepIndex: number, key: ParameterKey): any => {
  const step = steps[stepIndex];
  if (step && key in step) {
    return step[key];
  }
  return undefined;
};
