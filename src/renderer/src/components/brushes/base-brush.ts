import { SetStateAction, WritableAtom } from "jotai";
import { RESET } from "jotai/utils";
import * as THREE from "three";
import { IUniform } from "three";
import { activeFileAtom, store } from "../../store";

export type SetStateActionWithReset<Value> = SetStateAction<Value> | typeof RESET;

export interface UpdateUniformsProps {
  brushCenterUv: THREE.Vector2;
  brushSizeUv: THREE.Vector2;
  sourceTexture: THREE.Texture;
  inverseMapTex: THREE.Texture;
  metadataTex: THREE.Texture;
  zoomPower: number;
  scroll: number;
  featherX: number;
  featherY: number;
  brushIntensity: number;
  offsetUv: THREE.Vector2;
  pan: number;
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
  unit?: string;
};

export type SelectParameter<T extends string = string> = BaseParameter<T, SetStateActionWithReset<T>> & {
  type: "select";
  options: readonly T[];
};

export type SwitchParameter = BaseParameter<boolean, SetStateActionWithReset<boolean>> & {
  type: "switch";
};

export type BrushParameter = SliderParameter | SelectParameter<any> | SwitchParameter;

export abstract class BaseBrush {
  abstract material: THREE.ShaderMaterial;
  abstract parameters: BrushParameter[];

  updateUniforms(props: UpdateUniformsProps): void {
    const {
      brushCenterUv,
      brushSizeUv,
      zoomPower,
      scroll,
      featherX,
      featherY,
      brushIntensity,
      offsetUv,
      pan,
      sourceTexture,
      inverseMapTex,
      metadataTex,
    } = props;
    const uniforms = this.material.uniforms;
    const activeFile = store.get(activeFileAtom);

    if (!activeFile) return;
    const spectrogramData = activeFile.spectrogramData;

    uniforms.packedDataTex.value = sourceTexture;
    uniforms.inverseMapTex.value = inverseMapTex;
    uniforms.metadataTex.value = metadataTex;
    uniforms.numFrames.value = spectrogramData.numFrames;
    uniforms.numBands.value = spectrogramData.numBands;
    uniforms.numChannels.value = spectrogramData.numChannels;
    uniforms.packedTextureSize.value = spectrogramData.packedTextureSize;
    uniforms.sampleRate.value = spectrogramData.sampleRate;
    uniforms.brushCenterUv.value.copy(brushCenterUv);
    uniforms.brushSizeUv.value.copy(brushSizeUv);
    uniforms.zoomPower.value = zoomPower;
    uniforms.scroll.value = scroll;
    uniforms.featherX.value = featherX;
    uniforms.featherY.value = featherY;
    uniforms.brushIntensity.value = brushIntensity;
    uniforms.offsetUv.value.copy(offsetUv);
    uniforms.pan.value = pan;
  }
}
