import { useStore } from "@/store";
import type { EffectsState } from "@renderer/store/effects";
import { GLSL3, RawShaderMaterial } from "three";
import passThroughVert from "../glsl/pass-through.vert";
import sortEffectFrag from "../glsl/sort-effect.frag";
import { withPlatformDefines } from "../lib/shader-utils";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

// Pass layout: [H-even, H-odd, V-even, V-odd]
// sortAxis:        0       0     1       1
// passIndexOffset: 0       1     0       1
const PASS_AXIS = [0, 0, 1, 1];
const PASS_PARITY = [0, 1, 0, 1];

class SortEffect extends BaseEffect {
  materials: RawShaderMaterial[];
  parameters: (keyof EffectsState)[];

  constructor() {
    super();
    this.materials = PASS_AXIS.map(
      (axis, i) =>
        new RawShaderMaterial({
          uniforms: {
            ...defaultValues,
            sortDirection: { value: 0 },
            sortOrder: { value: 0 },
            sortBy: { value: 0 },
            sortStereoMode: { value: 0 },
            sortAxis: { value: axis },
            passIndexOffset: { value: PASS_PARITY[i] },
          },
          vertexShader: passThroughVert,
          fragmentShader: withPlatformDefines(sortEffectFrag),
          glslVersion: GLSL3,
        }),
    );

    this.parameters = ["sortDirection", "sortOrder", "sortBy", "sortStereoMode"];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const { sortDirection, sortOrder, sortBy, sortStereoMode } = state;

    const { passIndex } = props;
    const material = this.materials[passIndex];
    if (!material) return;

    material.uniforms.sortDirection.value = sortDirection;
    material.uniforms.sortOrder.value = sortOrder;
    material.uniforms.sortBy.value = sortBy;
    material.uniforms.sortStereoMode.value = sortStereoMode;
    // sortAxis and passIndexOffset are fixed per material — not overridden here.
    // Override useLinearBlend to true so applyBrush uses exact linear mix for stable swaps.
    material.uniforms.useLinearBlend.value = true;
  }
}

export const sortEffect = new SortEffect();
