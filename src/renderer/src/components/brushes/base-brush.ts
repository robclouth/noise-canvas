import { SetStateAction, WritableAtom } from "jotai";
import { RESET } from "jotai/utils";
import * as THREE from "three";
import { IUniform } from "three";
import { CommonUniforms } from "./common";
export type SetStateActionWithReset<Value> = SetStateAction<Value> | typeof RESET;

export interface BrushUniforms {
  [uniform: string]: IUniform;
}

export type ParameterType = "slider" | "select";

type BaseParameter<T, A> = {
  atom: WritableAtom<T, [A], void>;
  label: string;
};

export type SliderValue = {
  value: number;
  label: string;
};

type BaseSliderParameter = BaseParameter<number, SetStateActionWithReset<number>> & {
  type: "slider";
  isLog?: boolean;
  unit?: string;
};

export type ContinuousSliderParameter = BaseSliderParameter & {
  min: number;
  max: number;
  step: number;
  values?: never;
};

export type SteppedSliderParameter = BaseSliderParameter & {
  values: SliderValue[];
  min?: never;
  max?: never;
  step?: never;
};

export type SliderParameter = ContinuousSliderParameter | SteppedSliderParameter;

export type SelectParameter<T extends string = string> = BaseParameter<T, SetStateActionWithReset<T>> & {
  type: "select";
  options: readonly T[];
};

export type SwitchParameter = BaseParameter<boolean, SetStateActionWithReset<boolean>> & {
  type: "switch";
};

export type BrushParameter = SliderParameter | SelectParameter<any> | SwitchParameter;

export abstract class BaseBrush {
  abstract materials: THREE.ShaderMaterial[];
  abstract parameters: BrushParameter[];

  updateUniforms(props: CommonUniforms, passIndex: number): void {
    const material = this.materials[passIndex];
    if (!material) return;

    for (const key in props) {
      if (key in material) {
        material.uniforms[key].value = props[key];
      }
    }
  }
}
