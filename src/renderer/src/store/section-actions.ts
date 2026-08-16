import type { EffectItem } from "@renderer/effects/types";
import {
  randomizeBooleanParameter,
  randomizeNumberParameter,
  randomizeOptionsParameter,
} from "@renderer/lib/randomize";
import { getEffectType, parameterDefs } from "@renderer/parameters";
import { getEffectParameterValue, getModulationParamKeys, getParameterValue } from ".";
import type { ParameterKey, State } from "./types";

type SetParameter = (key: ParameterKey, value: unknown, effectId?: string) => void;

/**
 * Where a section-wide action writes `key`. `undefined` names the step or the
 * global layer; a string names one effect instance.
 *
 * An effect card reads its values from that instance's `params`, which shadow
 * the step layer, so a header with no `effectId` of its own has to write every
 * instance in the chain that carries the parameter — writing the step would
 * leave the cards showing their old values.
 */
export function sectionWriteTargets(state: State, key: ParameterKey, effectId?: string): (string | undefined)[] {
  const effectType = getEffectType(key);
  if (!effectType) return [undefined];
  if (effectId) return [effectId];

  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const effects = (steps[state.activeStepIndex]?.effects ?? []) as EffectItem[];
  return effects.filter((item) => item.effect === effectType).map((item) => item.id);
}

/** Writes every parameter of a section, and its modulation amounts, back to the defaults. */
export function resetSectionParameters(
  parameterKeys: ParameterKey[],
  effectId: string | undefined,
  getState: () => State,
  setParameter: SetParameter,
): void {
  for (const key of parameterKeys) {
    const def = parameterDefs[key];
    if (!def) continue;

    for (const target of sectionWriteTargets(getState(), key, effectId)) {
      setParameter(key, def.default, target);
      if (def.kind !== "number" || !def.modulatable) continue;
      for (const modKey of getModulationParamKeys(key)) {
        const modDef = parameterDefs[modKey];
        if (modDef) setParameter(modKey, modDef.default, target);
      }
    }
  }
}

export interface RandomizeSectionOptions {
  /** How far a value may move, 0–100. */
  amount: number;
  modulationEnabled: boolean;
  /** Parameter keys the user has held back from randomisation. */
  excluded: string[];
}

/** Moves every parameter of a section away from its current value by `amount`. */
export function randomizeSectionParameters(
  parameterKeys: ParameterKey[],
  effectId: string | undefined,
  { amount, modulationEnabled, excluded }: RandomizeSectionOptions,
  getState: () => State,
  setParameter: SetParameter,
): void {
  for (const key of parameterKeys) {
    if (excluded.includes(key as string)) continue;
    const def = parameterDefs[key];
    if (!def) continue;

    for (const target of sectionWriteTargets(getState(), key, effectId)) {
      const state = getState();
      const currentValue = target ? getEffectParameterValue(state, target, key) : getParameterValue(state, key);

      let newValue: unknown;
      switch (def.kind) {
        case "number":
          newValue = randomizeNumberParameter(currentValue as number, def.min, def.max, amount);
          break;
        case "options":
          newValue = randomizeOptionsParameter(
            currentValue,
            def.options.map((option) => option.value),
            amount,
          );
          break;
        case "boolean":
          newValue = randomizeBooleanParameter(currentValue as boolean, amount);
          break;
        default:
          continue;
      }

      setParameter(key, newValue, target);

      if (!modulationEnabled || def.kind !== "number" || !def.modulatable) continue;
      for (const modKey of getModulationParamKeys(key)) {
        const modDef = parameterDefs[modKey];
        if (modDef?.kind === "number") {
          setParameter(modKey, randomizeNumberParameter(0, modDef.min, modDef.max, amount), target);
        }
      }
    }
  }
}
