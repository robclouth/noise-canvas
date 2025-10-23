import { OpenFile } from "@renderer/store/types";
import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RedFormat, ShaderMaterial } from "three";
import overtonesFrag from "../glsl/overtones-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useStore } from "../store";
import { BaseEffect, CommonUniforms, defaultValues } from "./base-effect";
import { shapes } from "./overtones-shapes";

class OvertonesEffect extends BaseEffect {
  shapeTexture: DataTexture | null = null;
  prevShape: keyof typeof shapes | null = null;

  constructor() {
    super();
    this.materials = [
      new ShaderMaterial({
        uniforms: {
          ...defaultValues,
          overtonesScale: {
            value: {
              value: 1.0,
              minValue: -4.0,
              maxValue: 4.0,
              modulationAmounts: [],
            },
          },
          overtonesDecay: {
            value: {
              value: 0.0,
              minValue: 0,
              maxValue: 1,
              modulationAmounts: [],
            },
          },
          shapeTexture: { value: null },
        },
        vertexShader: passThroughVert,
        fragmentShader: overtonesFrag,
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

  updateEffectUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void {
    this.updateCommonUniforms(props);
    const state = useStore.getState();
    const { overtonesCount, overtonesShape, overtonesScale, overtonesDecay } = state;

    const shapeTexture = this.getShapeTexture(overtonesShape.value, overtonesCount.value);

    const material = this.materials[props.passIndex];

    material.uniforms.overtonesScale.value = {
      value: overtonesScale.value,
      minValue: overtonesScale.min,
      maxValue: overtonesScale.max,
      modulationAmounts: overtonesScale.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
    };
    material.uniforms.overtonesDecay.value = {
      value: overtonesDecay.value / 100,
      minValue: overtonesDecay.min / 100,
      maxValue: overtonesDecay.max / 100,
      modulationAmounts: overtonesDecay.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
    };
    material.uniforms.shapeTexture = { value: shapeTexture };
  }
}

export const overtonesEffect = new OvertonesEffect();
