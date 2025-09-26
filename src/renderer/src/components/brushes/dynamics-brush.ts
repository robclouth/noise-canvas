import { shaderMaterial } from "@react-three/drei";
import { ShaderMaterial } from "three";
import { useStore } from "../../store";
import { BaseBrush, BrushParameter } from "./base-brush";
import { brushMain, common, CommonUniforms, defaultValues, vertexShader } from "./common";

const DynamicsMaterial = shaderMaterial(
  {
    ...defaultValues,
    threshold: -20.0,
    ratio: 4.0,
    makeupGain: 0.0,
    attack: 0.01,
    release: 0.1,
    knee: 10.0,
  },
  vertexShader,
  /*glsl*/ `
    uniform float threshold;
    uniform float ratio;
    uniform float makeupGain;
    uniform float attack;
    uniform float release;
    uniform float knee;

    ${common}

    float dbToLin(float db) {
        return pow(10.0, db / 20.0);
    }

    float linToDb(float lin) {
        return 20.0 * log(lin + 1e-6) / log(10.0);
    }

    // Level detection with simulated attack/release
    float detectLevel(vec2 uv, float attack, float release) {
        float attackSamples = attack * sourceSampleRate;
        float releaseSamples = release * sourceSampleRate;

        float avgMag = 0.0;
        float totalWeight = 0.0;

        // Simplified: sample a few points in a window
        for (float i = -3.0; i <= 3.0; i++) {
            float timeOffset = i * (1.0 / sourceFrameCount);
            vec4 texel = sampleFromSource(uv + vec2(timeOffset, 0.0));
            float mag = length(texel.rg) + length(texel.ba);

            float weight = 1.0;
            if (i < 0.0) weight = exp(i / (attackSamples / 1000.0));
            else weight = exp(-i / (releaseSamples / 1000.0));

            avgMag += mag * weight;
            totalWeight += weight;
        }

        return (totalWeight > 0.0) ? avgMag / totalWeight : 0.0;
    }

    vec4 applyBrushStroke(vec4 sourceTexel, Coords coords) {
        float currentMag = length(sourceTexel.rg) + length(sourceTexel.ba);
        float inputDb = linToDb(currentMag);

        float overage = inputDb - threshold;
        float gainReductionDb = 0.0;

        // Compression / Expansion logic
        if (ratio >= 1.0) { // Compression
            if (overage > 0.0) {
                gainReductionDb = overage * (1.0 - 1.0 / ratio);
            }
        } else { // Expansion
            if (overage < 0.0) {
                gainReductionDb = overage * (1.0 - 1.0 / ratio);
            }
        }
        
        // Apply knee
        float kneeZone = knee / 2.0;
        if (abs(overage) < kneeZone) {
            float kneeAmount = (overage + kneeZone) / knee;
            gainReductionDb *= kneeAmount * kneeAmount;
        }

        float gain = dbToLin(-gainReductionDb + makeupGain);
        return sourceTexel * gain;
    }
    
    ${brushMain}
  `,
);

class DynamicsBrush extends BaseBrush {
  materials: ShaderMaterial[];
  parameters: BrushParameter[];

  constructor() {
    super();
    this.materials = [new DynamicsMaterial()];
    this.parameters = [
      {
        type: "slider",
        param: "dynamicsThreshold",
        label: "Threshold",
        min: -60,
        max: 0,
        step: 0.1,
        unit: "dB",
      },
      {
        type: "slider",
        param: "dynamicsRatio",
        label: "Ratio",
        min: 0.1,
        max: 100,
        step: 0.1,
      },
      {
        type: "slider",
        param: "dynamicsMakeupGain",
        label: "Makeup",
        min: 0,
        max: 30,
        step: 0.1,
        unit: "dB",
      },
      {
        type: "slider",
        param: "dynamicsAttack",
        label: "Attack",
        min: 0.001,
        max: 0.2,
        step: 0.001,
        unit: "s",
      },
      {
        type: "slider",
        param: "dynamicsRelease",
        label: "Release",
        min: 0.01,
        max: 1.0,
        step: 0.01,
        unit: "s",
      },
      {
        type: "slider",
        param: "dynamicsKnee",
        label: "Knee",
        min: 0,
        max: 20,
        step: 0.1,
        unit: "dB",
      },
    ];
  }

  updateUniforms(props: CommonUniforms, passIndex: number): void {
    super.updateUniforms(props, passIndex);
    const { dynamicsThreshold, dynamicsRatio, dynamicsMakeupGain, dynamicsAttack, dynamicsRelease, dynamicsKnee } =
      useStore.getState();
    this.materials[passIndex].uniforms.threshold.value = dynamicsThreshold;
    let ratio = dynamicsRatio;
    if (ratio >= 99) {
      ratio = 1000.0; // A very high number for "infinity"
    }
    this.materials[passIndex].uniforms.ratio.value = ratio;
    this.materials[passIndex].uniforms.makeupGain.value = dynamicsMakeupGain;
    this.materials[passIndex].uniforms.attack.value = dynamicsAttack;
    this.materials[passIndex].uniforms.release.value = dynamicsRelease;
    this.materials[passIndex].uniforms.knee.value = dynamicsKnee;
  }
}

export const dynamicsBrush = new DynamicsBrush();
