import { useStore } from "@/store";
import { unitsToUv } from "@renderer/lib/utils";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import type { State } from "@renderer/store/types";
import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  GLSL3,
  NearestFilter,
  RawShaderMaterial,
  RedFormat,
  Vector2,
} from "three";
import cloneBrushFrag from "../glsl/clone-effect.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { withPlatformDefines } from "../lib/shader-utils";
import { BaseEffect, defaultValues, UpdateEffectUniformsProps } from "./base-effect";
import { activeClonePasses, buildShapeTable, CloneShapeKey } from "./clone-shapes";

const uniforms = {
  ...defaultValues,
  cloneSpaceX: {
    value: {
      value: 0,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: [],
      contextualModAmounts: [],
      macroAmounts: [],
    },
  },
  cloneSpaceY: {
    value: {
      value: 0,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: [],
      contextualModAmounts: [],
      macroAmounts: [],
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
      macroAmounts: [],
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
  cloneSumMode: {
    value: 0,
  },
};

type ShapeCacheEntry = { key: string; texture: DataTexture };

function createShapeTexture(table: number[]): DataTexture {
  const data = new Float32Array(table);
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

class CloneEffect extends BaseEffect {
  materials: RawShaderMaterial[];
  private shapeCache: (ShapeCacheEntry | null)[] = [null, null];

  constructor() {
    super();
    this.materials = [
      new RawShaderMaterial({
        uniforms: {
          ...uniforms,
          cloneDirection: { value: new Vector2(1, 0) },
          cloneShapeTex: { value: null },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(cloneBrushFrag),
        glslVersion: GLSL3,
      }),
      new RawShaderMaterial({
        uniforms: {
          ...uniforms,
          cloneDirection: { value: new Vector2(0, 1) },
          cloneShapeTex: { value: null },
        },
        vertexShader: passThroughVert,
        fragmentShader: withPlatformDefines(cloneBrushFrag),
        glslVersion: GLSL3,
      }),
    ];
  }

  getActivePasses(state: State): number[] {
    return activeClonePasses(state.cloneCountX, state.cloneCountY);
  }

  private getShapeTexture(
    passIndex: number,
    shapeKey: CloneShapeKey,
    count: number,
    scaleTonic: string,
    scaleType: string,
  ): DataTexture {
    const key = `${shapeKey}|${count}|${scaleTonic}|${scaleType}`;
    const cached = this.shapeCache[passIndex];
    if (cached && cached.key === key) return cached.texture;

    const texture = createShapeTexture(buildShapeTable(shapeKey, count, scaleTonic, scaleType));
    cached?.texture.dispose();
    this.shapeCache[passIndex] = { key, texture };
    return texture;
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
      cloneShapeX,
      cloneShapeY,
      cloneSumMode,
      scaleTonic,
      scaleType,
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
      macroAmounts: getMacroAmountValuesNormalized(state, "cloneSpaceBeats"),
    };
    material.uniforms.cloneSpaceY.value = {
      value: spaceUv.y,
      minValue: -0.5,
      maxValue: 0.5,
      modulationAmounts: getModAmountValuesNormalized(state, "cloneSpaceSemis"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "cloneSpaceSemis"),
      macroAmounts: getMacroAmountValuesNormalized(state, "cloneSpaceSemis"),
    };
    const count = passIndex === 0 ? cloneCountX : cloneCountY;
    material.uniforms.cloneCount.value = count;
    material.uniforms.cloneDecay.value = {
      value: cloneDecay / 100,
      minValue: 0,
      maxValue: 1,
      modulationAmounts: getModAmountValuesNormalized(state, "cloneDecay"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "cloneDecay"),
      macroAmounts: getMacroAmountValuesNormalized(state, "cloneDecay"),
    };
    material.uniforms.cloneDirectionMode.value = passIndex === 0 ? cloneDirectionX : cloneDirectionY;
    material.uniforms.cloneEdgeMode.value = cloneEdgeMode;
    material.uniforms.cloneSumMode.value = cloneSumMode;
    material.uniforms.cloneShapeTex.value = this.getShapeTexture(
      passIndex,
      passIndex === 0 ? cloneShapeX : cloneShapeY,
      count,
      scaleTonic,
      scaleType,
    );
  }
}

export const cloneEffect = new CloneEffect();
