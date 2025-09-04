import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { code, unitsToUv, uniforms, vertexShader } from "./common";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { store, spectrogramDataAtom, bpmAtom, analysisParams } from "../../store";

export const blurXAtom = atomWithStorage("blurX", 0.0625); // in beats
export const blurYAtom = atomWithStorage("blurY", 1); // in semitones

const BlurMaterial = shaderMaterial(
  {
    ...uniforms,
    blurSizeUv: new THREE.Vector2(0.01, 0.01),
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform vec2 blurSizeUv;

    ${code}

    void main() {
        vec2 unpackedUv = getUnpackedUvFromPackedUv(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(unpackedUv)) {
            vec4 blurredTexel = vec4(0.0);
            float totalWeight = 0.0;
            // Simple box blur
            for (int x = -2; x <= 2; x++) {
                for (int y = -2; y <= 2; y++) {
                    vec2 offset = vec2(float(x), float(y)) * blurSizeUv;
                    vec2 unpackedSampleUv = unpackedUv + offset;
                    
                    if (isInBrush(unpackedSampleUv)) {
                        blurredTexel += getDataFromLogicalUv(unpackedSampleUv);
                        totalWeight += 1.0;
                    }
                }
            }
            if (totalWeight > 0.0) {
              gl_FragColor = blurredTexel / totalWeight;
            } else {
              gl_FragColor = originalTexel;
            }
        } else {
            gl_FragColor = originalTexel;
        }
    }
  `,
);

class BlurBrush extends BaseBrush {
  material: THREE.ShaderMaterial;
  parameters: BrushParameter[];

  constructor() {
    super();
    this.material = new BlurMaterial();
    this.parameters = [
      {
        type: "slider",
        atom: blurXAtom,
        label: "Blur X",
        propName: "blurX",
        min: -6,
        max: 0,
        step: 1,
        formatValue: (value) => `${value < 1 ? `1/${1 / value}` : value} beats`,
        isLog: true,
      },
      {
        type: "slider",
        atom: blurYAtom,
        label: "Blur Y",
        propName: "blurY",
        min: 0,
        max: 24,
        step: 1,
        formatValue: (value) => `${value.toFixed(0)} semitones`,
      },
    ];
  }

  updateUniforms(props: UpdateUniformsProps): void {
    super.updateUniforms(props);

    const spectrogramData = store.get(spectrogramDataAtom);
    const bpm = store.get(bpmAtom);
    const blurX = store.get(blurXAtom);
    const blurY = store.get(blurYAtom);

    if (!spectrogramData) return;

    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const blurSizeUv = unitsToUv(
      blurX,
      blurY,
      bpm,
      totalDuration,
      analysisParams.bandsPerOctave,
      spectrogramData.numBands,
    );

    this.material.uniforms.blurSizeUv.value.copy(blurSizeUv);
  }
}

export const blurBrush = new BlurBrush();
