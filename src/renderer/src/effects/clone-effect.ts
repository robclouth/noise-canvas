import { useStore } from "@/store";
import { getNumberParameterDef } from "@renderer/parameters";
import { buildScaleOffsets, minFreqSemisAboveC0 } from "@renderer/lib/scale-snap";
import {
  getContextualModAmountsNormalized,
  getModAmountValuesNormalized,
  getMacroAmountValuesNormalized,
} from "@renderer/store/modulators";
import type { State } from "@renderer/store/types";
import { normalizeParameterValue } from "@renderer/store/utils";
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
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";
import { activeClonePasses, buildShapeTable, CloneShapeKey } from "./clone-shapes";

function createUniforms() {
  return {
    ...createDefaultUniforms(),
    cloneSpaceX: {
      value: {
        value: 0.5,
        minValue: 0,
        maxValue: 1,
        modulationAmounts: [],
        contextualModAmounts: [],
        macroAmounts: [],
      },
    },
    cloneSpaceY: {
      value: {
        value: 0,
        minValue: -96,
        maxValue: 96,
        modulationAmounts: [],
        contextualModAmounts: [],
        macroAmounts: [],
      },
    },
    cloneBeatsLog: {
      value: 0,
    },
    cloneBeatsToUv: {
      value: 0,
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
    cloneScaleSnap: {
      value: false,
    },
    brushBasePitchAbsSemis: {
      value: 0,
    },
  };
}

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
          ...createUniforms(),
          cloneDirection: { value: new Vector2(1, 0) },
          cloneShapeTex: { value: null },
          scaleOffsets: { value: new Float32Array(12) },
        },
        vertexShader: passThroughVert,
        fragmentShader: cloneBrushFrag,
        glslVersion: GLSL3,
      }),
      new RawShaderMaterial({
        uniforms: {
          ...createUniforms(),
          cloneDirection: { value: new Vector2(0, 1) },
          cloneShapeTex: { value: null },
          scaleOffsets: { value: new Float32Array(12) },
        },
        vertexShader: passThroughVert,
        fragmentShader: cloneBrushFrag,
        glslVersion: GLSL3,
      }),
    ];
  }

  getActivePasses(state: State): number[] {
    return activeClonePasses(state.cloneCountX, state.cloneCountY);
  }

  private getShapeTexture(passIndex: number, shapeKey: CloneShapeKey, count: number): DataTexture {
    const key = `${shapeKey}|${count}`;
    const cached = this.shapeCache[passIndex];
    if (cached && cached.key === key) return cached.texture;

    const texture = createShapeTexture(buildShapeTable(shapeKey, count));
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
      scaleTonic,
      scaleType,
      filepathsBpm,
    } = state;
    const { spectrogramData, filePath } = file;
    if (!spectrogramData) return;

    const bpm = filepathsBpm[filePath] || 120;
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

    // The beats gap crosses to the shader as its knob position, so modulation
    // sweeps the log-bipolar arc the knob has, not the file's raw UV span.
    const beatsDef = getNumberParameterDef("cloneSpaceBeats");
    material.uniforms.cloneSpaceX.value = {
      value: normalizeParameterValue("cloneSpaceBeats", cloneSpaceBeats),
      minValue: 0,
      maxValue: 1,
      modulationAmounts: getModAmountValuesNormalized(state, "cloneSpaceBeats"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "cloneSpaceBeats"),
      macroAmounts: getMacroAmountValuesNormalized(state, "cloneSpaceBeats"),
    };
    material.uniforms.cloneBeatsLog.value = Math.log1p(Math.max(Math.abs(beatsDef.min), Math.abs(beatsDef.max)));
    material.uniforms.cloneBeatsToUv.value = 60 / bpm / (totalDuration > 0 ? totalDuration : 1);

    const semisDef = getNumberParameterDef("cloneSpaceSemis");
    material.uniforms.cloneSpaceY.value = {
      value: cloneSpaceSemis,
      minValue: semisDef.min,
      maxValue: semisDef.max,
      modulationAmounts: getModAmountValuesNormalized(state, "cloneSpaceSemis"),
      contextualModAmounts: getContextualModAmountsNormalized(state, "cloneSpaceSemis"),
      macroAmounts: getMacroAmountValuesNormalized(state, "cloneSpaceSemis"),
    };
    // Counts are copies added; the shader's tap count includes the original.
    const count = (passIndex === 0 ? cloneCountX : cloneCountY) + 1;
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

    const shapeKey = passIndex === 0 ? cloneShapeX : cloneShapeY;
    material.uniforms.cloneShapeTex.value = this.getShapeTexture(passIndex, shapeKey, count);

    // Scale-shape snapping anchors to the brush's pitch-low edge, the position
    // the pointer snap places on a scale note (same anchor as transform).
    material.uniforms.cloneScaleSnap.value = passIndex === 1 && shapeKey === "scale";
    material.uniforms.scaleOffsets.value = buildScaleOffsets(scaleTonic, scaleType);
    const bandsPerSemitone = spectrogramData.bandsPerOctave / 12;
    const bandIndex = props.commonUniforms.brushBottomLeftUv.value.y * spectrogramData.numBands;
    material.uniforms.brushBasePitchAbsSemis.value =
      minFreqSemisAboveC0(spectrogramData.minFreq) + bandIndex / bandsPerSemitone;
  }
}

export const cloneEffect = new CloneEffect();
