import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { code, unitsToUv, uniforms, vertexShader } from "./common";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { store, activeFileAtom, bpmAtom, bandsPerOctaveAtom } from "../../store";

export const blurXAtom = atomWithStorage("blurX", 0.0625); // in beats
export const blurYCentsAtom = atomWithStorage("blurYCents", 100); // in cents

const blurShader = (direction: "x" | "y") => /*glsl*/ `
  precision highp float;
  varying vec2 vUv;

  uniform vec2 blurSizeUv;

  ${code}
  
  void main() {
      Coords coords = getCoords(vUv);
      vec4 originalTexel = texture2D(packedDataTex, vUv);

      if (isInBrush(coords.dest)) {
          vec4 blurredTexel = vec4(0.0);
          float totalWeight = 0.0;
          
          const int kernelRadius = 8;

          for (int i = -kernelRadius; i <= kernelRadius; i++) {
              vec2 offset = ${direction === "x" ? "vec2(float(i), 0.0)" : "vec2(0.0, float(i))"} * blurSizeUv / float(kernelRadius);
              vec2 sampleUv = coords.source + offset;
              
              if (isInBrush(sampleUv + offsetUv)) {
                  blurredTexel += sampleFromSource(sampleUv);
                  totalWeight += 1.0;
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
`;

const BlurMaterialX = shaderMaterial(
  {
    ...uniforms,
    blurSizeUv: new THREE.Vector2(0.01, 0.01),
  },
  vertexShader,
  blurShader("x"),
);

const BlurMaterialY = shaderMaterial(
  {
    ...uniforms,
    blurSizeUv: new THREE.Vector2(0.01, 0.01),
  },
  vertexShader,
  blurShader("y"),
);

class BlurBrush extends BaseBrush {
  materials: THREE.ShaderMaterial[];
  parameters: BrushParameter[];

  constructor() {
    super();
    this.materials = [new BlurMaterialX(), new BlurMaterialY()];
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

  updateUniforms(props: UpdateUniformsProps, passIndex: number): void {
    super.updateUniforms(props, passIndex);

    const activeFile = store.get(activeFileAtom);
    const bpm = store.get(bpmAtom);
    const blurX = store.get(blurXAtom);
    const blurYCents = store.get(blurYCentsAtom);

    if (!activeFile) return;
    const spectrogramData = activeFile.spectrogramData;

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

    this.materials[passIndex].uniforms.blurSizeUv.value.copy(blurSizeUv);
  }
}

export const blurBrush = new BlurBrush();
