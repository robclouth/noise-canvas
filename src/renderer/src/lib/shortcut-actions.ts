import { parameterDefs } from "@renderer/parameters";
import { getParameterValue, useStore } from "@renderer/store";
import type { ParameterKey } from "@renderer/store/types";
import { randomizeSectionParameters } from "@renderer/store/section-actions";
import { RANDOMIZABLE_BRUSH_SECTIONS, sectionStorageKey } from "./brush-sections";
import { randomizeEffects } from "./randomize";

/** Values a parameter's marks sit close enough to count as the same stop. */
const MARK_EPSILON = 1e-6;

/**
 * Steps a numeric parameter to its next marked value, e.g. the brush size
 * stops. The ends hold rather than wrap, so a run of presses settles there.
 */
export function cycleParameterMark(key: ParameterKey, direction: 1 | -1): void {
  const def = parameterDefs[key];
  if (def?.kind !== "number" || !def.marks?.length) return;

  const values = def.marks.map((mark) => mark.value).sort((a, b) => a - b);
  const state = useStore.getState();
  const current = getParameterValue(state, key) as number;
  const next =
    direction > 0
      ? values.find((value) => value > current + MARK_EPSILON)
      : [...values].reverse().find((value) => value < current - MARK_EPSILON);

  if (next === undefined) return;
  state.setParameter(key, next);
}

/**
 * Re-rolls the active brush's sections, each at the amount and the modulation
 * setting its own menu holds, and skipping the parameters held back there.
 * `includeEffectOrder` also shuffles the effect chain.
 */
export function randomizeBrush(includeEffectOrder: boolean): void {
  const state = useStore.getState();

  for (const section of RANDOMIZABLE_BRUSH_SECTIONS) {
    const storageKey = sectionStorageKey(section.label);
    const amount = state.randomizationAmounts[storageKey] ?? 100;
    if (amount <= 0) continue;
    const modulationEnabled = (state.randomizationAmounts[`${storageKey}-mod`] ?? 0) > 0;

    randomizeSectionParameters(
      section.parameterKeys,
      undefined,
      { amount, modulationEnabled, excluded: state.excludedFromRandomization },
      useStore.getState,
      state.setParameter,
    );

    if (!includeEffectOrder || !section.includeEffectOrder) continue;
    const effects = getParameterValue(useStore.getState(), "effects") as Parameters<typeof randomizeEffects>[0];
    state.setParameter("effects", randomizeEffects(effects, amount));
  }
}
