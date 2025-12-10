import { produce } from "immer";
import { BrushStep, createDefaultStep, isStepParameter } from "@renderer/parameters";
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
  getActiveStep: () => BrushStep;
  setStepParameter: (key: ParameterKey, value: any) => void;
}

export const createStepsSlice = (set: ZustandSet, get: ZustandGet): StepsState => ({
  steps: [createDefaultStep()],
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
        // Duplicate the currently active step
        const currentStep = draft.steps[draft.activeStepIndex];
        const newStep = { ...currentStep };
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
        const newStep = { ...stepToDuplicate };
        draft.steps.splice(index + 1, 0, newStep);
        draft.activeStepIndex = index + 1;
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
});

/** Get a step parameter value from a specific step */
export const getStepParameterValue = (steps: BrushStep[], stepIndex: number, key: ParameterKey): any => {
  const step = steps[stepIndex];
  if (step && key in step) {
    return step[key];
  }
  return undefined;
};

