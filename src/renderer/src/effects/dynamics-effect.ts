import { getNumberParameterDef } from "@renderer/parameters";
import { GLSL3, RawShaderMaterial } from "three";
import dynamicsEffectFrag from "../glsl/dynamics-effect.frag";
import rangeQuadVert from "../glsl/range-quad.vert";
import { useStore } from "../store";
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";

class DynamicsEffect extends BaseEffect {
  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...createDefaultUniforms(),
          thresholdDb: { value: defaultParameterUniform(-20.0, -60, 0) },
          upperRatio: { value: defaultParameterUniform(1.0, -2.0, 2.0) },
          lowerRatio: { value: defaultParameterUniform(1.0, -2.0, 2.0) },
          knee: { value: defaultParameterUniform(6.0, 0.0, 24.0) },
          gainDb: { value: defaultParameterUniform(0.0, -80, 24) },
        },
        vertexShader: rangeQuadVert,
        fragmentShader: dynamicsEffectFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  updateEffectUniforms(props: UpdateEffectUniformsProps): void {
    this.updateCommonUniforms(props);
    const state = props.state ?? useStore.getState();

    const thresholdDb = state.dynamicsThresholdDb;
    const thresholdDbDef = getNumberParameterDef("dynamicsThresholdDb");
    this.materials[props.passIndex].uniforms.thresholdDb.value = parameterUniform(
      state,
      "dynamicsThresholdDb",
      props.modContext,
      { value: thresholdDb, min: thresholdDbDef.min, max: thresholdDbDef.max },
    );

    const upperRatio = state.dynamicsUpperRatio;
    const upperRatioDef = getNumberParameterDef("dynamicsUpperRatio");
    this.materials[props.passIndex].uniforms.upperRatio.value = parameterUniform(
      state,
      "dynamicsUpperRatio",
      props.modContext,
      { value: upperRatio, min: upperRatioDef.min, max: upperRatioDef.max },
    );

    const lowerRatio = state.dynamicsLowerRatio;
    const lowerRatioDef = getNumberParameterDef("dynamicsLowerRatio");
    this.materials[props.passIndex].uniforms.lowerRatio.value = parameterUniform(
      state,
      "dynamicsLowerRatio",
      props.modContext,
      { value: lowerRatio, min: lowerRatioDef.min, max: lowerRatioDef.max },
    );

    const knee = state.dynamicsKnee;
    const kneeDef = getNumberParameterDef("dynamicsKnee");
    this.materials[props.passIndex].uniforms.knee.value = parameterUniform(state, "dynamicsKnee", props.modContext, {
      value: knee,
      min: kneeDef.min,
      max: kneeDef.max,
    });

    const gainDb = state.dynamicsGainDb;
    const gainDbDef = getNumberParameterDef("dynamicsGainDb");
    this.materials[props.passIndex].uniforms.gainDb.value = parameterUniform(
      state,
      "dynamicsGainDb",
      props.modContext,
      { value: gainDb, min: gainDbDef.min, max: gainDbDef.max },
    );
  }
}

export const dynamicsEffect = new DynamicsEffect();
