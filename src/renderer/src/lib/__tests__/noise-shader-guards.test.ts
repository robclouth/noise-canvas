import { describe, expect, it } from "vitest";

import noiseSource from "../../glsl/noise.glsl?raw";
import effectCommonSource from "../../glsl/effect-common.glsl?raw";
import displaySource from "../../glsl/display.frag?raw";

/**
 * Two hazards in the noise patterns that only bite at particular inputs, so a
 * render test would not reliably reach them: a `smoothstep` whose edges run
 * backwards, which GLSL ES 3.0 leaves undefined, and a weight sum that is zero
 * when every tap sits past the falloff radius near a lattice corner.
 */
describe("noise.glsl guards", () => {
  it("never calls smoothstep with a descending edge pair", () => {
    const shaders = { noise: noiseSource, "effect-common": effectCommonSource, display: displaySource };
    const descending: string[] = [];
    let checked = 0;
    for (const [name, source] of Object.entries(shaders)) {
      for (const [call, edge0, edge1] of source.matchAll(/smoothstep\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,/g)) {
        checked++;
        if (parseFloat(edge0) >= parseFloat(edge1)) descending.push(`${name}: ${call}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(descending).toEqual([]);
  });

  it("guards the Voronoi weight sum against a zero divisor", () => {
    expect(noiseSource).toContain("wt > 0.0 ? va / wt : 0.0");
    expect(noiseSource).not.toContain("return va / wt;");
  });
});
