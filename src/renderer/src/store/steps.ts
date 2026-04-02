import { BrushStep, createDefaultStep, isStepParameter } from "@renderer/parameters";
import { produce } from "immer";
import type { ParameterKey, State, ZustandGet, ZustandSet } from "./types";

export const MAX_STEPS = 10;

export const STEPS_PERSISTED_KEYS = ["activeStepIndex"] as const;

export interface StepsState {
  activeStepIndex: number;
  setActiveStepIndex: (index: number) => void;
  addStep: () => void;
  removeStep: (index: number) => void;
  duplicateStep: (index: number) => void;
  reorderSteps: (from: number, to: number) => void;
  getActiveStep: () => BrushStep;
  getSteps: () => BrushStep[];
  setStepParameter: (key: ParameterKey, value: unknown) => void;
  setStepName: (index: number, name: string) => void;
  updateActiveStepLockedOffset: (offset: { beats: number; pitch: number } | null) => void;
}

export const createStepsSlice = (set: ZustandSet, get: ZustandGet): StepsState => ({
  activeStepIndex: 0,

  setActiveStepIndex: (index: number) => {
    const state = get();
    const steps = state.slots[state.activeSlotIndex] ?? [];
    if (index >= 0 && index < steps.length) {
      set({ activeStepIndex: index });
    }
  },

  addStep: () => {
    const state = get();
    const steps = state.slots[state.activeSlotIndex] ?? [];
    if (steps.length >= MAX_STEPS) return;

    set(
      produce((draft: State) => {
        const draftSteps = draft.slots[draft.activeSlotIndex];
        if (!draftSteps) return;
        const nextStepNumber = draftSteps.length + 1;
        const newStep = createDefaultStep(`Step ${nextStepNumber}`);
        draftSteps.push(newStep);
        draft.activeStepIndex = draftSteps.length - 1;
      }),
    );
  },

  removeStep: (index: number) => {
    const state = get();
    const steps = state.slots[state.activeSlotIndex] ?? [];
    if (steps.length <= 1) return;
    if (index < 0 || index >= steps.length) return;

    set(
      produce((draft: State) => {
        const draftSteps = draft.slots[draft.activeSlotIndex];
        if (!draftSteps) return;
        draftSteps.splice(index, 1);
        // Adjust activeStepIndex if needed
        if (draft.activeStepIndex >= draftSteps.length) {
          draft.activeStepIndex = draftSteps.length - 1;
        } else if (draft.activeStepIndex > index) {
          draft.activeStepIndex--;
        }
      }),
    );
  },

  duplicateStep: (index: number) => {
    const state = get();
    const steps = state.slots[state.activeSlotIndex] ?? [];
    if (steps.length >= MAX_STEPS) return;
    if (index < 0 || index >= steps.length) return;

    set(
      produce((draft: State) => {
        const draftSteps = draft.slots[draft.activeSlotIndex];
        if (!draftSteps) return;
        const stepToDuplicate = draftSteps[index];
        const newStep = { ...stepToDuplicate, id: crypto.randomUUID() };
        draftSteps.splice(index + 1, 0, newStep);
        draft.activeStepIndex = index + 1;
      }),
    );
  },

  reorderSteps: (fromIndex: number, toIndex: number) => {
    set(
      produce((draft: State) => {
        const draftSteps = draft.slots[draft.activeSlotIndex];
        if (!draftSteps) return;
        const activeStep = draftSteps[draft.activeStepIndex];
        const [movedStep] = draftSteps.splice(fromIndex, 1);
        draftSteps.splice(toIndex, 0, movedStep);

        // Update active step index to point to the same step object
        draft.activeStepIndex = draftSteps.indexOf(activeStep);
      }),
    );
  },

  getActiveStep: () => {
    const state = get();
    const steps = state.slots[state.activeSlotIndex] ?? [];
    return steps[state.activeStepIndex] || steps[0] || createDefaultStep("Step 1");
  },

  getSteps: () => {
    const state = get();
    return state.slots[state.activeSlotIndex] ?? [createDefaultStep("Step 1")];
  },

  setStepParameter: (key: ParameterKey, value: unknown) => {
    if (!isStepParameter(key)) return;

    set(
      produce((draft: State) => {
        const draftSteps = draft.slots[draft.activeSlotIndex];
        if (draftSteps && draftSteps[draft.activeStepIndex]) {
          (draftSteps[draft.activeStepIndex] as Record<string, unknown>)[key] = value;
        }
      }),
    );
  },

  setStepName: (index: number, name: string) => {
    set(
      produce((draft: State) => {
        const draftSteps = draft.slots[draft.activeSlotIndex];
        if (draftSteps && draftSteps[index]) {
          draftSteps[index].name = name;
        }
      }),
    );
  },

  updateActiveStepLockedOffset: (offset) => {
    set(
      produce((draft: State) => {
        const draftSteps = draft.slots[draft.activeSlotIndex];
        if (draftSteps && draftSteps[draft.activeStepIndex]) {
          draftSteps[draft.activeStepIndex].lockedOffset = offset;
        }
      }),
    );
  },
});

/** Get a step parameter value from a specific step */
export const getStepParameterValue = (
  steps: BrushStep[],
  stepIndex: number,
  key: ParameterKey,
): BrushStep[ParameterKey] | undefined => {
  const step = steps[stepIndex];
  if (step && key in step) {
    return step[key];
  }
  return undefined;
};
