import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { store } from "../../store";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { code, uniforms, vertexShader } from "./common";

export const dynamicsThresholdAtom = atomWithStorage("dynamicsThreshold", -20.0);
export const dynamicsRatioAtom = atomWithStorage("dynamicsRatio", 4.0);
export const dynamicsMakeupGainAtom = atomWithStorage("dynamicsMakeupGain", 0.0);
export const dynamicsAttackAtom = atomWithStorage("dynamicsAttack", 0.01);
export const dynamicsReleaseAtom = atomWithStorage("dynamicsRelease", 0.1);
export const dynamicsKneeAtom = atomWithStorage("dynamicsKnee", 10.0);

const DynamicsMaterial = shaderMaterial(
  {
    ...uniforms,
    threshold: -20.0,
    ratio: 4.0,
    makeupGain: 0.0,
    attack: 0.01,
    release: 0.1,
    knee: 10.0,
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform float threshold;
    uniform float ratio;
    uniform float makeupGain;
    uniform float attack;
    uniform float release;
    uniform float knee;

    ${code}

    float dbToLin(float db) {
        return pow(10.0, db / 20.0);
    }

    float linToDb(float lin) {
        return 20.0 * log(lin + 1e-6) / log(10.0);
    }

    // Level detection with simulated attack/release
    float detectLevel(vec2 uv, float attack, float release) {
        float attackSamples = attack * sampleRate;
        float releaseSamples = release * sampleRate;

        float avgMag = 0.0;
        float totalWeight = 0.0;

        // Simplified: sample a few points in a window
        for (float i = -3.0; i <= 3.0; i++) {
            float timeOffset = i * (1.0 / numFrames);
            vec4 texel = sampleSpectrogramPoint(uv + vec2(timeOffset, 0.0));
            float mag = length(texel.rg) + length(texel.ba);

            float weight = 1.0;
            if (i < 0.0) weight = exp(i / (attackSamples / 1000.0));
            else weight = exp(-i / (releaseSamples / 1000.0));

            avgMag += mag * weight;
            totalWeight += weight;
        }

        return (totalWeight > 0.0) ? avgMag / totalWeight : 0.0;
    }

    void main() {
        Coords coords = getCoords(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(coords.dest)) {
            vec4 currentTexel = sampleSpectrogramPoint(coords.source);
            float currentMag = length(currentTexel.rg) + length(currentTexel.ba);
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
            vec4 modifiedTexel = currentTexel * gain;

            float weight = getFeatherWeight(coords.dest);
            gl_FragColor = applyBrushEffect(originalTexel, modifiedTexel, weight);
        } else {
            gl_FragColor = originalTexel;
        }
    }
  `,
);

class DynamicsBrush extends BaseBrush {
  material: THREE.ShaderMaterial;
  parameters: BrushParameter[];

  constructor() {
    super();
    this.material = new DynamicsMaterial();
    this.parameters = [
      {
        type: "slider",
        atom: dynamicsThresholdAtom,
        label: "Threshold",
        propName: "threshold",
        min: -60,
        max: 0,
        step: 0.1,
        unit: "dB",
      },
      {
        type: "slider",
        atom: dynamicsRatioAtom,
        label: "Ratio",
        propName: "ratio",
        min: 0.1,
        max: 100,
        step: 0.1,
        formatValue: (v) => {
          if (v >= 99) return "Inf";
          if (v < 1) return `1:${(1 / v).toFixed(1)}`;
          return `${v.toFixed(1)}:1`;
        },
      },
      {
        type: "slider",
        atom: dynamicsMakeupGainAtom,
        label: "Makeup",
        propName: "makeupGain",
        min: 0,
        max: 30,
        step: 0.1,
        unit: "dB",
      },
      {
        type: "slider",
        atom: dynamicsAttackAtom,
        label: "Attack",
        propName: "attack",
        min: 0.001,
        max: 0.2,
        step: 0.001,
        unit: "s",
      },
      {
        type: "slider",
        atom: dynamicsReleaseAtom,
        label: "Release",
        propName: "release",
        min: 0.01,
        max: 1.0,
        step: 0.01,
        unit: "s",
      },
      {
        type: "slider",
        atom: dynamicsKneeAtom,
        label: "Knee",
        propName: "knee",
        min: 0,
        max: 20,
        step: 0.1,
        unit: "dB",
      },
    ];
  }

  updateUniforms(props: UpdateUniformsProps): void {
    super.updateUniforms(props);
    this.material.uniforms.threshold.value = store.get(dynamicsThresholdAtom);
    let ratio = store.get(dynamicsRatioAtom);
    if (ratio >= 99) {
      ratio = 1000.0; // A very high number for "infinity"
    }
    this.material.uniforms.ratio.value = ratio;
    this.material.uniforms.makeupGain.value = store.get(dynamicsMakeupGainAtom);
    this.material.uniforms.attack.value = store.get(dynamicsAttackAtom);
    this.material.uniforms.release.value = store.get(dynamicsReleaseAtom);
    this.material.uniforms.knee.value = store.get(dynamicsKneeAtom);
  }
}

export const dynamicsBrush = new DynamicsBrush();
