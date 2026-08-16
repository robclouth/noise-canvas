import { beforeEach, describe, expect, it } from "vitest";

import type { EffectItem, EffectType } from "../../effects/types";
import { getEffectParameterDefaults, getEffectParameterKeys, getParameterDef, parameterDefs } from "../../parameters";
import { getEffectParameterValue, getParameterValue, useStore } from "../../store";
import { makeEmptyBrush } from "../../store/brush-factory";
import { randomizeSectionParameters, resetSectionParameters, sectionWriteTargets } from "../../store/section-actions";
import type { ParameterKey } from "../../store/types";

/**
 * The Effects section header covers every effect, so it names no single effect
 * instance. Effect values live on the instances and shadow the step layer, so a
 * header action that writes the step reaches nothing the cards read.
 */

const BLUR_TIME = "blurAmountTime" as ParameterKey;
const THRESHOLD = "dynamicsThresholdDb" as ParameterKey;
const CONVOLVE_GAIN = "convolveGainDb" as ParameterKey;
const INTENSITY = "brushIntensity" as ParameterKey;

const ALL_EFFECT_PARAMS = Object.keys(parameterDefs).filter((key) =>
  Boolean(parameterDefs[key as ParameterKey]?.effectType),
) as ParameterKey[];

function effectItem(id: string, effect: EffectType): EffectItem {
  return { id, effect, enabled: true, params: getEffectParameterDefaults(effect) };
}

/** Puts a single brush with `effects` in its only step into the live store. */
function installChain(...effects: EffectItem[]): (key: ParameterKey, value: unknown, effectId?: string) => void {
  const brush = makeEmptyBrush("test-palette");
  useStore.setState({ brushes: [brush], activeBrushIndex: 0, activeStepIndex: 0 });
  const { setParameter } = useStore.getState();
  setParameter("effects", effects);
  return setParameter;
}

describe("section write targets", () => {
  beforeEach(() => {
    installChain(effectItem("blur-a", "blur"), effectItem("blur-b", "blur"), effectItem("dyn", "dynamics"));
  });

  it("names every instance of the parameter's own effect", () => {
    expect(sectionWriteTargets(useStore.getState(), BLUR_TIME)).toEqual(["blur-a", "blur-b"]);
    expect(sectionWriteTargets(useStore.getState(), THRESHOLD)).toEqual(["dyn"]);
  });

  it("names the step layer for a parameter that belongs to no effect", () => {
    expect(sectionWriteTargets(useStore.getState(), INTENSITY)).toEqual([undefined]);
  });

  it("names nothing when the chain holds no instance of that effect", () => {
    expect(sectionWriteTargets(useStore.getState(), CONVOLVE_GAIN)).toEqual([]);
  });

  it("keeps to the one card when the menu names an effect", () => {
    expect(sectionWriteTargets(useStore.getState(), BLUR_TIME, "blur-b")).toEqual(["blur-b"]);
  });
});

describe("resetting a section", () => {
  it("returns every effect instance in the chain to its defaults", () => {
    const setParameter = installChain(
      effectItem("blur-a", "blur"),
      effectItem("blur-b", "blur"),
      effectItem("dyn", "dynamics"),
    );
    setParameter(BLUR_TIME, 0.42, "blur-a");
    setParameter(BLUR_TIME, 0.17, "blur-b");
    setParameter(THRESHOLD, -40, "dyn");

    resetSectionParameters(ALL_EFFECT_PARAMS, undefined, useStore.getState, setParameter);

    const state = useStore.getState();
    expect(getEffectParameterValue(state, "blur-a", BLUR_TIME)).toBe(getParameterDef(BLUR_TIME).default);
    expect(getEffectParameterValue(state, "blur-b", BLUR_TIME)).toBe(getParameterDef(BLUR_TIME).default);
    expect(getEffectParameterValue(state, "dyn", THRESHOLD)).toBe(getParameterDef(THRESHOLD).default);
  });

  it("leaves the other cards alone when the menu names one effect", () => {
    const setParameter = installChain(effectItem("blur-a", "blur"), effectItem("blur-b", "blur"));
    setParameter(BLUR_TIME, 0.42, "blur-a");
    setParameter(BLUR_TIME, 0.17, "blur-b");

    resetSectionParameters(getEffectParameterKeys("blur"), "blur-a", useStore.getState, setParameter);

    const state = useStore.getState();
    expect(getEffectParameterValue(state, "blur-a", BLUR_TIME)).toBe(getParameterDef(BLUR_TIME).default);
    expect(getEffectParameterValue(state, "blur-b", BLUR_TIME)).toBe(0.17);
  });

  it("still writes the step layer for a section of plain step parameters", () => {
    const setParameter = installChain(effectItem("blur-a", "blur"));
    setParameter(INTENSITY, 0.25);

    resetSectionParameters([INTENSITY], undefined, useStore.getState, setParameter);

    expect(getParameterValue(useStore.getState(), INTENSITY)).toBe(getParameterDef(INTENSITY).default);
  });

  it("sends a modulation amount to the same instance as its parameter", () => {
    installChain(effectItem("blur-a", "blur"));
    const targets = new Map<string, string | undefined>();

    resetSectionParameters([BLUR_TIME], undefined, useStore.getState, (key, _value, effectId) => {
      targets.set(key as string, effectId);
    });

    expect(targets.get(BLUR_TIME as string)).toBe("blur-a");
    expect(targets.get(`${BLUR_TIME}Mod1Amount`)).toBe("blur-a");
  });
});

describe("randomising a section", () => {
  it("writes each effect instance rather than the step", () => {
    installChain(effectItem("blur-a", "blur"), effectItem("blur-b", "blur"));
    const written: (string | undefined)[] = [];

    randomizeSectionParameters(
      [BLUR_TIME],
      undefined,
      { amount: 100, modulationEnabled: false, excluded: [] },
      useStore.getState,
      (_key, _value, effectId) => {
        written.push(effectId);
      },
    );

    expect(written).toEqual(["blur-a", "blur-b"]);
  });

  it("holds back a parameter the user excluded", () => {
    installChain(effectItem("blur-a", "blur"));
    const written: ParameterKey[] = [];

    randomizeSectionParameters(
      [BLUR_TIME],
      undefined,
      { amount: 100, modulationEnabled: false, excluded: [BLUR_TIME as string] },
      useStore.getState,
      (key) => {
        written.push(key);
      },
    );

    expect(written).toEqual([]);
  });
});
