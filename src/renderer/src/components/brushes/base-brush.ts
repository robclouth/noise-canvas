import { WritableAtom, SetStateAction } from "jotai";
import * as THREE from "three";
import { IUniform } from "three";
import { OpenFile, SpectrogramData, activeFileAtom, sourceFileAtom, store } from "../../store";
import { RESET } from "jotai/utils";

export type SetStateActionWithReset<Value> = SetStateAction<Value> | typeof RESET;

export interface UpdateUniformsProps {
  brushCenterUv: THREE.Vector2;
  brushSizeUv: THREE.Vector2;
  sourceTexture: THREE.Texture;
  crossFileTexture: THREE.Texture | null;
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

export type SwitchParameter = {
  type: "switch";
  atom: WritableAtom<boolean, [typeof RESET], void> | WritableAtom<boolean, [SetStateAction<boolean>], void>;
  label: string;
  propName: string;
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
      crossFileTexture,
    } = props;
    const uniforms = this.material.uniforms;
    const activeFile = store.get(activeFileAtom);
    const sourceFile = store.get(sourceFileAtom);

    if (!activeFile) return;
    const spectrogramData = activeFile.spectrogramData;

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
    uniforms.zoomPower.value = zoomPower;
    uniforms.scroll.value = scroll;
    uniforms.featherX.value = featherX;
    uniforms.featherY.value = featherY;
    uniforms.brushIntensity.value = brushIntensity;
    uniforms.offsetUv.value.copy(offsetUv);
    uniforms.pan.value = pan;

    const sourceSelected = crossFileTexture && sourceFile;
    uniforms.sourceSelected.value = sourceSelected;
    if (sourceSelected) {
      uniforms.sourceTexture.value = crossFileTexture;
      uniforms.sourceMetadataTex.value = sourceFile.spectrogramData.metadataTex;
      uniforms.sourcePackedTextureSize.value = sourceFile.spectrogramData.packedTextureSize;
      uniforms.sourceNumFrames.value = sourceFile.spectrogramData.numFrames;
      uniforms.sourceNumBands.value = sourceFile.spectrogramData.numBands;
      uniforms.sourceSampleRate.value = sourceFile.spectrogramData.sampleRate;
    }
  }
}
