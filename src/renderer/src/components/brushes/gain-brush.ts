import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import { ShaderMaterial } from "three";
import { store } from "../../store";
import { BaseBrush, BrushParameter } from "./base-brush";
import { code, CommonUniforms, defaultValues, vertexShader } from "./common";

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
    precision highp float;
    varying vec2 vUv;

    uniform float gainDb;

    ${code}

    void main() {
        Coords coords = getCoords(vUv);
        vec4 originalTexel = sampleSpectrogramPointInterpolated(coords.dest);

        if (isInBrush(coords.dest)) {
            float weight = getFeatherWeight(coords.dest);
            float gain = pow(10.0, gainDb / 20.0);
            
            vec4 sourceTexel = sampleSpectrogramTransformed(coords.source, coords.dest);
            vec4 modifiedTexel = sourceTexel * gain;

            gl_FragColor = applyBrushEffect(originalTexel, modifiedTexel, weight);
        } else {
            gl_FragColor = originalTexel;
        }
    }
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
