import * as THREE from "three";
import { IUniform } from "three";

export interface BrushUniforms {
  [uniform: string]: IUniform;
}

export abstract class BaseBrush {
  abstract material: THREE.ShaderMaterial;
  abstract updateUniforms(props: Record<string, any>): void;
}
