import { deepMerge } from "@mantine/core";
import { effects, EffectType } from "@renderer/effects";
import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import { createAppSlice } from "./app";
import { createAudioSlice } from "./audio";
import { createBrushSlice } from "./brush";
import { createEffectsSlice } from "./effects";
import { createFilesSlice } from "./files";
import { createModulatorsSlice } from "./modulators";
import { createPresetsSlice } from "./presets";
import type { Parameter, ParameterKey, State } from "./types";

export const PERSISTED_KEYS: (keyof State)[] = [
  "filepathsBpm",
  "sectionCollapsed",
  "presetHotkeys",
  "loop",
  "autoPlayStroke",
];

export const useStore = create<State>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        ...createBrushSlice(set, get),
        ...createEffectsSlice(set, get),
        ...createModulatorsSlice(set, get),
        ...createFilesSlice(set, get),
        ...createAudioSlice(set, get),
        ...createAppSlice(set, get),
        ...createPresetsSlice(set, get),
      }),
      {
        name: "noise-canvas-storage",
        partialize: (state) => {
          return Object.entries(state).reduce(
            (acc, [key, value]) => {
              if (typeof value === "object" && value !== null && "value" in value) {
                acc[key] = { value: (value as Parameter<unknown>).value };
              } else if (PERSISTED_KEYS.includes(key as keyof State)) {
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
            const missingEffects = allEffects.filter(
              (effect) => !currentOrder.value.map((o) => o.effect).includes(effect),
            );

            if (missingEffects.length > 0) {
              // Add missing effects to the end
              const newOrder = [...currentOrder.value, ...missingEffects.map((effect) => ({ effect, enabled: false }))];
              currentOrder.setValue(newOrder);
            }
          }
        },
      },
    ),
  ),
);

export function getModulator(index: number) {
  const state = useStore.getState();
  return {
    modulatorMode: state[`modulator${index}Mode` as ParameterKey],
    modulatorPatternShape: state[`modulator${index}PatternShape` as ParameterKey],
    modulatorPatternRateBeats: state[`modulator${index}PatternRateBeats` as ParameterKey],
    modulatorPatternRateSemis: state[`modulator${index}PatternRateSemis` as ParameterKey],
    modulatorStrength: state[`modulator${index}Strength` as ParameterKey],
    modulatorRotation: state[`modulator${index}Rotation` as ParameterKey],
    modulatorPhaseMode: state[`modulator${index}PhaseMode` as ParameterKey],
  };
}
