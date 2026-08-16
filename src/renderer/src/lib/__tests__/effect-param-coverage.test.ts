import { describe, expect, it } from "vitest";

import { EFFECT_KEYS, type EffectType } from "../../effects/types";
import { getAllEffectParameterKeys, getEffectParameterKeys, parameterDefs } from "../../parameters";
import type { ParameterKey } from "../../store/types";

/** Vite inlines these at build time, so the scan reads what is actually on disk. */
const sources = import.meta.glob("../../components/**/*.tsx", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

/**
 * The Effects section header's reset, randomise and section-preset actions act
 * on a list of parameter keys. Hand-listed, that list went nine effects out of
 * date and quietly skipped them. These check the lists are still derived.
 */
describe("effect parameter coverage", () => {
  it("collects every effect parameter, of every type", () => {
    const all = new Set(getAllEffectParameterKeys());
    for (const key of EFFECT_KEYS) {
      for (const param of getEffectParameterKeys(key as EffectType)) {
        expect(all.has(param)).toBe(true);
      }
    }
    const declared = (Object.keys(parameterDefs) as ParameterKey[]).filter(
      (key) => parameterDefs[key]?.effectType !== undefined,
    );
    expect(all.size).toBe(declared.length);
  });

  it("names no effect type that has parameters but no coverage", () => {
    const withParams = EFFECT_KEYS.filter((key) => getEffectParameterKeys(key as EffectType).length > 0);
    // Every effect except passthrough and align carries parameters today; a new
    // one landing here means the derivation stopped seeing it.
    expect(withParams.length).toBeGreaterThanOrEqual(12);
  });

  it("keeps every effect parameter reachable from a card, including the edge modes", () => {
    for (const key of ["convolveEdgeMode", "blurEdgeMode", "cloneEdgeMode", "evolveEdgeMode", "transformEdgeMode"]) {
      expect(getAllEffectParameterKeys()).toContain(key as ParameterKey);
    }
  });

  it("derives both lists rather than spelling them out", () => {
    const brushPanel = Object.entries(sources).find(([path]) => path.endsWith("layout/brush-panel.tsx"))?.[1] ?? "";
    const effectsList =
      Object.entries(sources).find(([path]) => path.endsWith("components/effects-list.tsx"))?.[1] ?? "";
    expect(brushPanel).toContain("getAllEffectParameterKeys()");
    expect(effectsList).toContain("getEffectParameterKeys(key)");
  });
});
