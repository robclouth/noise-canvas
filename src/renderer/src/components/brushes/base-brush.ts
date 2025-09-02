import { WritableAtom } from "jotai";
import * as THREE from "three";
import { IUniform } from "three";

export interface BrushUniforms {
  [uniform: string]: IUniform;
}

export type ParameterType = "slider";

export interface BrushParameter {
  type: ParameterType;
  atom: WritableAtom<number, number[], void>;
  label: string;
  min: number;
  max: number;
  step: number;
  formatValue: (value: number) => string;
}

export abstract class BaseBrush {
  abstract material: THREE.ShaderMaterial;
  abstract parameters: BrushParameter[];
  abstract updateUniforms(props: Record<string, any>): void;
}
