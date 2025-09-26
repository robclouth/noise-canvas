import { State } from "@/store";
import * as THREE from "three";
import { IUniform } from "three";
import { CommonUniforms } from "./common";

export interface BrushUniforms {
  [uniform: string]: IUniform;
}

export abstract class BaseBrush {
  materials: THREE.ShaderMaterial[] = [];
  parameters: (keyof State)[] = [];

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
