import { State } from "@/store";
import { OpenFile } from "@renderer/types";
import * as THREE from "three";
import { IUniform } from "three";
import { CommonUniforms } from "./common";

export interface BrushUniforms {
  [uniform: string]: IUniform;
}

export abstract class BaseBrush {
  materials: THREE.ShaderMaterial[] = [];
  parameters: (keyof State)[] = [];

  abstract updateBrushUniforms(props: { commonUniforms: CommonUniforms; passIndex: number; file: OpenFile }): void;

  updateCommonUniforms({ commonUniforms, passIndex }: { commonUniforms: CommonUniforms; passIndex: number }): void {
    const material = this.materials[passIndex];
    if (!material) return;

    for (const key in commonUniforms) {
      if (key in material) {
        material.uniforms[key].value = commonUniforms[key];
      }
    }
  }
}
