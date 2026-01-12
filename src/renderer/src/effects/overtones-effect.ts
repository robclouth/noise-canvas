import { getNumberParameterDef } from "@renderer/parameters";
import { getContextualModAmountsNormalized, getModAmountValuesNormalized } from "@renderer/store/modulators";
import { ClampToEdgeWrapping, DataTexture, FloatType, GLSL3, NearestFilter, RawShaderMaterial, RedFormat } from "three";
import overtonesFrag from "../glsl/overtones-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";
import { shapes } from "./overtones-shapes";

class OvertonesEffect extends BaseEffect {
  shapeTexture: DataTexture | null = null;
  prevShape: keyof typeof shapes | null = null;

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...defaultValues,
          overtonesScale: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          overtonesDecay: {
            value: {
              value: 0.0,
              minValue: 0,
              maxValue: 1,
              modulationAmounts: [],
              contextualModAmounts: [],
            },
          },
          shapeTexture: { value: null },
        },
        vertexShader: passThroughVert,
        fragmentShader: overtonesFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  getShapeTexture(shapeKey: keyof typeof shapes, count: number): DataTexture {
    if (this.prevShape === shapeKey && this.shapeTexture) {
      return this.shapeTexture;
    }
    this.prevShape = shapeKey;

    const shape = shapes[shapeKey];
    const data = new Float32Array(shape.create(count));

    const texture = new DataTexture(data, data.length, 1, RedFormat, FloatType);
    texture.internalFormat = "R32F";
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();
    const { overtonesCount, overtonesShape, overtonesScale, overtonesDecay } = state;

    const overtonesScaleDef = getNumberParameterDef("overtonesScale");
    const overtonesDecayDef = getNumberParameterDef("overtonesDecay");

    const shapeTexture = this.getShapeTexture(overtonesShape, overtonesCount);

    const material = this.materials[props.passIndex];

    material.uniforms.overtonesScale.value = {
      value: overtonesScale,
      minValue: overtonesScaleDef.min,
      maxValue: overtonesScaleDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "overtonesScale"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "overtonesScale"),
    };
    material.uniforms.overtonesDecay.value = {
      value: overtonesDecay / 100,
      minValue: overtonesDecayDef.min / 100,
      maxValue: overtonesDecayDef.max / 100,
      modulationAmounts: getModAmountValuesNormalized(state, "overtonesDecay"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "overtonesDecay"),
    };
    material.uniforms.shapeTexture = { value: shapeTexture };
  }
}

export const overtonesEffect = new OvertonesEffect();
