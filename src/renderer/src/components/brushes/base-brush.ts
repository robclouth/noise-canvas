import { WritableAtom } from "jotai";
import { SetStateActionWithReset } from "jotai/utils";
import * as THREE from "three";
import { IUniform } from "three";
import { store, spectrogramDataAtom } from "../../store";

export interface UpdateUniformsProps {
  brushCenterUv: THREE.Vector2;
  brushSizeUv: THREE.Vector2;
  sourceTexture: THREE.Texture;
}

export interface BrushUniforms {
  [uniform: string]: IUniform;
}

export type ParameterType = "slider" | "select";

type BaseParameter<T, A> = {
  atom: WritableAtom<T, [A], void>;
  label: string;
  propName: string;
};

export type SliderParameter = BaseParameter<number, SetStateActionWithReset<number>> & {
  type: "slider";
  min: number;
  max: number;
  step: number;
  formatValue: (value: number) => string;
  isLog?: boolean;
};

export type SelectParameter = BaseParameter<string, SetStateActionWithReset<string>> & {
  type: "select";
  options: readonly string[];
};

export type BrushParameter = SliderParameter | SelectParameter;

export abstract class BaseBrush {
  abstract material: THREE.ShaderMaterial;
  abstract parameters: BrushParameter[];

  updateUniforms(props: UpdateUniformsProps): void {
    const { brushCenterUv, brushSizeUv, sourceTexture } = props;
    const uniforms = this.material.uniforms;
    const spectrogramData = store.get(spectrogramDataAtom);

    if (!spectrogramData) return;

    uniforms.packedDataTex.value = sourceTexture;
    uniforms.inverseMapTex.value = spectrogramData.inverseMapTex;
    uniforms.metadataTex.value = spectrogramData.metadataTex;
    uniforms.numFrames.value = spectrogramData.numFrames;
    uniforms.numBands.value = spectrogramData.numBands;
    uniforms.numChannels.value = spectrogramData.numChannels;
    uniforms.packedTextureSize.value = spectrogramData.packedTextureSize;
    uniforms.sampleRate.value = spectrogramData.sampleRate;
    uniforms.brushCenterUv.value.copy(brushCenterUv);
    uniforms.brushSizeUv.value.copy(brushSizeUv);
  }
}
