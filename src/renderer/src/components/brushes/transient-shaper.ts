import { shaderMaterial } from "@react-three/drei";
import { ShaderMaterial } from "three";
import { useStore } from "../../store";
import { BaseBrush, BrushParameter } from "./base-brush";
import { brushMain, common, CommonUniforms, defaultValues, vertexShader } from "./common";

const TransientShaperMaterial = shaderMaterial(
  {
    ...defaultValues,
    intensity: 0.5,
    threshold: 0.01,
    alignPhases: false,
  },
  vertexShader,
  /*glsl*/ `
    uniform float intensity;
    uniform float threshold;
    uniform bool alignPhases;

    ${common}

    vec4 applyBrushStroke(vec4 sourceTexel, Coords coords) {
        vec2 timeStep = vec2(1.0 / sourceFrameCount, 0.0);

        vec4 prevTexel = sampleFromSource(coords.source - timeStep);
        
        float prevMag = length(prevTexel.rg) + length(prevTexel.ba);
        float currentMag = length(sourceTexel.rg) + length(sourceTexel.ba);

        // Spectral flux based transient detection
        float spectralFlux = currentMag - prevMag;

        vec4 modifiedTexel = sourceTexel;

        if (spectralFlux > threshold) {
            // Apply intensity
            float boost = 1.0 + spectralFlux * intensity;
            modifiedTexel = sourceTexel * boost;

            // Align phases if toggled
            if (alignPhases) {
                vec2 magL = vec2(length(modifiedTexel.rg), 0.0);
                vec2 magR = vec2(length(modifiedTexel.ba), 0.0);
                modifiedTexel = vec4(magL, magR);
            }
        }

        return modifiedTexel;
    }

    ${brushMain}
  `,
);

class TransientShaperBrush extends BaseBrush {
  materials: ShaderMaterial[];
  parameters: BrushParameter[];

  constructor() {
    super();
    this.materials = [new TransientShaperMaterial()];
    this.parameters = [
      {
        type: "slider",
        param: "transientIntensity",
        label: "Intensity",
        min: 0,
        max: 5,
        step: 0.01,
        unit: "",
      },
      {
        type: "slider",
        param: "transientThreshold",
        label: "Threshold",
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        type: "switch",
        param: "alignPhases",
        label: "Align Phases",
      },
    ];
  }

  updateUniforms(props: CommonUniforms, passIndex: number): void {
    super.updateUniforms(props, passIndex);
    const { transientIntensity, transientThreshold, alignPhases } = useStore.getState();
    this.materials[passIndex].uniforms.intensity.value = transientIntensity;
    this.materials[passIndex].uniforms.threshold.value = transientThreshold;
    this.materials[passIndex].uniforms.alignPhases.value = alignPhases;
  }
}

export const transientShaperBrush = new TransientShaperBrush();
