import { useStore } from "@/store";
import { buildScaleOffsets, minFreqSemisAboveC0 } from "@renderer/lib/scale-snap";
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
import { defaultParameterUniform, parameterUniform } from "@renderer/lib/static-modulation";
import { BaseEffect, createDefaultUniforms, UpdateEffectUniformsProps } from "./base-effect";
import { activeClonePasses, buildShapeTable, CloneShapeKey } from "./clone-shapes";

function createUniforms() {
  return {
    ...createDefaultUniforms(),
    cloneSpaceX: { value: defaultParameterUniform(0.25, -32, 32) },
    cloneSpaceY: { value: defaultParameterUniform(0, -96, 96) },
    cloneBeatsLog: {
      value: 0,
    },
    cloneBeatsToUv: {
      value: 0,
    },
    cloneCount: {
      value: 4,
    },
    cloneDecay: { value: defaultParameterUniform(0.5, 0, 1) },
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

    // The gap reaches the shader in beats; the beat-to-UV factor carries the file's tempo.
    material.uniforms.cloneSpaceX.value = parameterUniform(state, "cloneSpaceBeats", props.modContext);
    material.uniforms.cloneBeatsToUv.value = 60 / bpm / (totalDuration > 0 ? totalDuration : 1);

    material.uniforms.cloneSpaceY.value = parameterUniform(state, "cloneSpaceSemis", props.modContext);
    // Counts are copies added; the shader's tap count includes the original.
    const count = (passIndex === 0 ? cloneCountX : cloneCountY) + 1;
    material.uniforms.cloneCount.value = count;
    material.uniforms.cloneDecay.value = parameterUniform(state, "cloneDecay", props.modContext, {
      value: cloneDecay / 100,
      min: 0,
      max: 1,
    });
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
