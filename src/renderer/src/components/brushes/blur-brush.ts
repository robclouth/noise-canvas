import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { code, unitsToUv, uniforms, vertexShader } from "./common";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { store, spectrogramDataAtom, bpmAtom, bandsPerOctaveAtom } from "../../store";

export const blurXAtom = atomWithStorage("blurX", 0.0625); // in beats
export const blurYCentsAtom = atomWithStorage("blurYCents", 100); // in cents

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

    vec4 getDataFromLogicalUv(vec2 logicalUv) {
        // HACK: for some reason the point sampler returns 0 here.
        // It's not worth debugging right now. Let's just use the slow one.
        return sampleSpectrogramPhaseCorrect(logicalUv);
    }
    
    void main() {
        Coords coords = getCoords(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(coords.dest)) {
            vec4 blurredTexel = vec4(0.0);
            float totalWeight = 0.0;
            // Simple box blur
            for (int x = -2; x <= 2; x++) {
                for (int y = -2; y <= 2; y++) {
                    vec2 offset = vec2(float(x), float(y)) * blurSizeUv;
                    vec2 sampleUv = coords.source + offset;
                    
                    // Check if the ORIGINAL location of this sample is in the brush
                    if (isInBrush(sampleUv + offsetUv)) {
                        blurredTexel += getDataFromLogicalUv(sampleUv);
                        totalWeight += 1.0;
                    }
                }
            }
            if (totalWeight > 0.0) {
              vec4 finalBlur = blurredTexel / totalWeight;
              float weight = getFeatherWeight(coords.dest);
              gl_FragColor = applyBrushEffect(originalTexel, finalBlur, weight);
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
        unit: "beats",
        formatValue: (value) => `${value < 1 ? `1/${1 / value}` : value}`,
        isLog: true,
      },
      {
        type: "slider",
        atom: blurYCentsAtom,
        label: "Blur Y",
        propName: "blurY",
        min: 0,
        max: 2400,
        step: 1,
        unit: "cents",
        formatValue: (value) => `${value.toFixed(0)}`,
      },
    ];
  }

  updateUniforms(props: UpdateUniformsProps): void {
    super.updateUniforms(props);

    const spectrogramData = store.get(spectrogramDataAtom);
    const bpm = store.get(bpmAtom);
    const blurX = store.get(blurXAtom);
    const blurYCents = store.get(blurYCentsAtom);

    if (!spectrogramData) return;

    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const bandsPerOctave = store.get(bandsPerOctaveAtom);
    const blurSizeUv = unitsToUv(
      blurX,
      blurYCents / 100, // convert cents to semitones
      bpm,
      totalDuration,
      bandsPerOctave,
      spectrogramData.numBands,
    );

    this.material.uniforms.blurSizeUv.value.copy(blurSizeUv);
  }
}

export const blurBrush = new BlurBrush();
