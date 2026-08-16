import { describe, expect, it } from "vitest";
import { effects } from "../../effects";
import { createDefaultUniforms } from "../../effects/base-effect";
import { sortEffect } from "../../effects/sort-effect";
import { blurEffect } from "../../effects/blur-effect";

const commonUniformKeys = Object.keys(createDefaultUniforms());

function allMaterials(): { label: string; uniforms: Record<string, { value: unknown }> }[] {
  const out: { label: string; uniforms: Record<string, { value: unknown }> }[] = [];
  for (const [name, effect] of Object.entries(effects)) {
    effect.materials.forEach((material, index) => {
      out.push({ label: `${name}[${index}]`, uniforms: material.uniforms });
    });
  }
  return out;
}

describe("effect uniform isolation", () => {
  it("gives every material its own common uniform wrappers", () => {
    const materials = allMaterials();
    expect(materials.length).toBeGreaterThan(1);

    const shared: string[] = [];
    for (const key of commonUniformKeys) {
      const owners = new Map<unknown, string>();
      for (const { label, uniforms } of materials) {
        const wrapper = uniforms[key];
        if (!wrapper) continue;
        const first = owners.get(wrapper);
        if (first) shared.push(`${key}: ${first} and ${label}`);
        else owners.set(wrapper, label);
      }
    }

    expect(shared).toEqual([]);
  });

  it("keeps Sort's linear-blend override out of every other material", () => {
    const sortMaterial = sortEffect.materials[0];
    const blurMaterial = blurEffect.materials[0];

    expect(blurMaterial.uniforms.useLinearBlend.value).toBe(false);
    sortMaterial.uniforms.useLinearBlend.value = true;
    expect(blurMaterial.uniforms.useLinearBlend.value).toBe(false);

    sortMaterial.uniforms.useLinearBlend.value = false;
  });
});
