import { describe, expect, it } from "vitest";

import { getQuantizeParamKey, parameterDefs } from "../../parameters";
import type { ParameterKey, State } from "../../store/types";
import { denormalizeParameterValue } from "../../store/utils";
import { formatModulationReach, modulationReach, REACH_BUDGET, reachWidth } from "../macro-targets";

/**
 * The reach replaces the value inside the num box, which is 70 px wide and 58 px in
 * compact, so a long one ellipsises and tells the user nothing. Measured on the built
 * app, the reach font renders 4.0–5.1 px per character at the compact size, with about
 * 43 px of room. This walks every parameter's whole span to keep the longest one inside
 * that budget.
 */

function reachAt(
  key: ParameterKey,
  quantize: boolean,
  position: number,
  weight: number,
  budget = REACH_BUDGET,
): string | null {
  const view = {
    [key]: denormalizeParameterValue(key, position),
    [`${key}ModQuantize`]: quantize,
  } as unknown as State;
  const reach = modulationReach(view, key, weight);
  return reach ? formatModulationReach(key, reach, budget) : null;
}

describe("reach text width", () => {
  const keys = (Object.keys(parameterDefs) as ParameterKey[]).filter((key) => getQuantizeParamKey(key) !== null);

  it("covers every quantisable parameter", () => {
    expect(keys.length).toBeGreaterThan(20);
  });

  it("sheds every scrap of detail before it lets a reach run over the budget", () => {
    for (const key of keys) {
      for (const quantize of [false, true]) {
        for (let p = 0; p <= 1.0001; p += 0.05) {
          for (let w = 0.05; w <= 1.0001; w += 0.05) {
            const position = Math.min(1, p);
            const weight = Math.min(1, w);
            const text = reachAt(key, quantize, position, weight);
            if (!text || reachWidth(text) <= REACH_BUDGET) continue;
            // Over the budget it has to be the leanest form already, with no decimals,
            // unit or mark name left to drop. Those run a character or two over and still
            // fit the box, because what is left of them is narrow: minus signs and spaces.
            expect(text, `${key} could be shorter`).toBe(reachAt(key, quantize, position, weight, 0));
          }
        }
      }
    }
  });
});
