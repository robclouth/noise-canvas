import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import { getContextualModAmountsNormalized, getModAmountValuesNormalized } from "@renderer/store/modulators";
import { GLSL3, RawShaderMaterial, Vector2 } from "three";
import cloneBrushFrag from "../glsl/clone-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { withPlatformDefines } from "../lib/shader-utils";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";

const uniforms = {
  ...defaultValues,
  cloneSpaceX: {
    value: {
      value: 0,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: [],
      contextualModAmounts: [],
    },
  },
  cloneSpaceY: {
    value: {
      value: 0,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: [],
      contextualModAmounts: [],
    },
  },
  cloneCount: {
    value: 4,
  },
  cloneDecay: {
    value: {
      value: 0.5,
      minValue: 0,
      maxValue: 1,
      modulationAmounts: [],
      contextualModAmounts: [],
    },
  },
  cloneDirection: {
    value: new Vector2(1, 0),
  },
  cloneDirectionMode: {
    value: 0,
  },
  cloneEdgeMode: {
    value: 1,
  },
};

class CloneEffect extends BaseEffect {
  materials: RawShaderMaterial[];

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...uniforms,
          cloneDirection: { value: new Vector2(1, 0) },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(cloneBrushFrag),
        glslVersion: GLSL3,
      }),
      new RawShaderMaterial({
        uniforms: {
          ...uniforms,
          cloneDirection: { value: new Vector2(0, 1) },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(cloneBrushFrag),
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);

    const { file, passIndex } = props;
    const material = this.materials[passIndex];
    if (!material) return;

    const state = props.state ?? useStore.getState();
    const {
      cloneSpaceBeats,
      cloneSpaceSemis,
      cloneCountX,
      cloneCountY,
      cloneDecay,
      cloneDirectionX,
      cloneDirectionY,
      cloneEdgeMode,
      filepathsBpm,
    } = state;
    const { spectrogramData, filePath } = file;
    if (!spectrogramData) return;

    const bpm = filepathsBpm[filePath] || 120;

    const spaceUv = unitsToUv(
      cloneSpaceBeats,
      cloneSpaceSemis,
      bpm,
      spectrogramData.numFrames / spectrogramData.sampleRate,
      spectrogramData.bandsPerOctave,
      spectrogramData.numBands,
    );

    material.uniforms.cloneSpaceX.value = {
      value: spaceUv.x,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: getModAmountValuesNormalized(state, "cloneSpaceBeats"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "cloneSpaceBeats"),
    };
    material.uniforms.cloneSpaceY.value = {
      value: spaceUv.y,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: getModAmountValuesNormalized(state, "cloneSpaceSemis"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "cloneSpaceSemis"),
    };
    material.uniforms.cloneCount.value = passIndex === 0 ? cloneCountX : cloneCountY;
    material.uniforms.cloneDecay.value = {
      value: cloneDecay / 100,
      minValue: 0,
      maxValue: 1,
      modulationAmounts: getModAmountValuesNormalized(state, "cloneDecay"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "cloneDecay"),
    };
    material.uniforms.cloneDirectionMode.value = passIndex === 0 ? cloneDirectionX : cloneDirectionY;
    material.uniforms.cloneEdgeMode.value = cloneEdgeMode;
  }
}

export const cloneEffect = new CloneEffect();
