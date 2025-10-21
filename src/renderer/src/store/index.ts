import { deepMerge } from "@mantine/core";
import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import { effects, EffectType } from "../effects";
import { createAudioSlice } from "./audio";
import { createBrushSlice } from "./brush";
import { createDisplaySlice } from "./display";
import { createEffectsSlice } from "./effects";
import { createFilesSlice } from "./files";
import { createModulatorsSlice } from "./modulators";
import { createPresetsSlice } from "./presets";
import type { Parameter, ParameterKey, State } from "./types";
import { persistedKeys } from "./utils";

export type {
  AudioState,
  BooleanParameter,
  BrushState,
  ContinuousNumberParameter,
  DiscreteNumberParameter,
  DisplayState,
  EffectsState,
  FileSettings,
  FilesState,
  ModulatorsState,
  OpenFile,
  OptionsParameter,
  Parameter,
  ParameterKey,
  PresetsState,
  SpectrogramData,
  State,
} from "./types";

export const useStore = create<State>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        ...createBrushSlice(set),
        ...createEffectsSlice(set),
        ...createModulatorsSlice(set),
        ...createFilesSlice(set, get),
        ...createAudioSlice(set, get),
        ...createDisplaySlice(set),
        ...createPresetsSlice(set, get),
      }),
      {
        name: "noise-canvas-storage",
        partialize: (state) => {
          return Object.entries(state).reduce(
            (acc, [key, value]) => {
              if (typeof value === "object" && value !== null && "value" in value) {
                acc[key] = { value: (value as Parameter<unknown>).value };
              } else if (persistedKeys.includes(key as keyof State)) {
                acc[key] = value;
              }
              return acc;
            },
            {} as Record<string, any>,
          );
        },
        merge: (persistedState, currentState) => deepMerge(currentState, persistedState),
        onRehydrateStorage: () => (state) => {
          if (state) {
            // Get all available effect types (excluding passthrough which is internal)
            const allEffects = (Object.keys(effects) as EffectType[]).filter((key) => key !== "passthrough");
            const currentOrder = state.effectOrder;
            const missingEffects = allEffects.filter((effect) => !currentOrder.includes(effect));

            if (missingEffects.length > 0) {
              // Add missing effects to the end
              const newOrder = [...currentOrder, ...missingEffects];
              state.setEffectOrder(newOrder);

              // Initialize missing effects as disabled in effectsEnabled
              const updatedEnabled = { ...state.effectsEnabled };
              missingEffects.forEach((effect) => {
                if (!(effect in updatedEnabled)) {
                  updatedEnabled[effect] = false;
                }
              });
              state.effectsEnabled = updatedEnabled;
            }
          }
        },
      },
    ),
  ),
);

export function getModulator(index: number) {
  return {
    modulatorMode: useStore.getState()[`modulator${index}Mode` as ParameterKey],
    modulatorPatternShape: useStore.getState()[`modulator${index}PatternShape` as ParameterKey],
    modulatorPatternRateBeats: useStore.getState()[`modulator${index}PatternRateBeats` as ParameterKey],
    modulatorPatternRateSemis: useStore.getState()[`modulator${index}PatternRateSemis` as ParameterKey],
    modulatorStrength: useStore.getState()[`modulator${index}Strength` as ParameterKey],
    modulatorRotation: useStore.getState()[`modulator${index}Rotation` as ParameterKey],
    modulatorPhaseMode: useStore.getState()[`modulator${index}PhaseMode` as ParameterKey],
  };
}
