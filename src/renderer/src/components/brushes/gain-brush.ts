import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import { ShaderMaterial } from "three";
import { store } from "../../store";
import { BaseBrush, BrushParameter } from "./base-brush";
import { brushMain, code, CommonUniforms, defaultValues, vertexShader } from "./common";

export const gainDbAtom = atomWithStorage("gainDb", 0.0);

type Uniforms = CommonUniforms & {
  gainDb: number;
};

const GainMaterial = shaderMaterial<Uniforms, ShaderMaterial & Uniforms>(
  {
    ...defaultValues,
    gainDb: 0.0,
  },
  vertexShader,
  /*glsl*/ `
    uniform float gainDb;

    ${code}

    vec4 applyBrushStroke(vec4 sourceTexel, Coords coords) {
      float gain = pow(10.0, gainDb / 20.0);
      return sourceTexel * gain;
    }

    ${brushMain}
  `,
);

class GainBrush extends BaseBrush {
  materials: ShaderMaterial[];
  parameters: BrushParameter[];

  constructor() {
    super();
    this.materials = [new GainMaterial()];
    this.parameters = [
      {
        type: "slider",
        atom: gainDbAtom,
        label: "Gain",
        min: -24,
        max: 24,
        step: 0.1,
        unit: "dB",
      },
    ];
  }

  updateUniforms(props: CommonUniforms, passIndex: number): void {
    super.updateUniforms(props, passIndex);
    Object.assign(this.materials[passIndex], { ...props, gainDb: store.get(gainDbAtom) });
  }
}

export const gainBrush = new GainBrush();
