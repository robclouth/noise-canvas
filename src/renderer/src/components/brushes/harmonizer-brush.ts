import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { scaleTonicAtom, scaleTypeAtom, store } from "../../store";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { code, uniforms, vertexShader } from "./common";

export const harmonizerAmountAtom = atomWithStorage("harmonizerAmount", 1.0);

const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const scales = {
  Major: 0b101011010101,
  Minor: 0b101101011010,
  "Pentatonic Major": 0b101010010100,
  "Pentatonic Minor": 0b100101010010,
  Blues: 0b100101110010,
};

const HarmonizerMaterial = shaderMaterial(
  {
    ...uniforms,
    amount: 1.0,
    scaleMask: scales.Major,
    rootNote: 0,
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform float amount;
    uniform int scaleMask;
    uniform int rootNote;

    ${code}
    
    float hzToMidi(float hz) {
        return 69.0 + 12.0 * log2(hz / 440.0);
    }

    float midiToHz(float midi) {
        return 440.0 * pow(2.0, (midi - 69.0) / 12.0);
    }

    float quantizePitch(float pitch) {
        float pitchInOctave = mod(pitch - float(rootNote), 12.0);
        int pitchInt = int(floor(pitchInOctave));

        int distUp = 0;
        int distDown = 0;

        for (int i = 0; i < 12; i++) {
            if (((scaleMask >> ((pitchInt + i) % 12)) & 1) == 1) {
                distUp = i;
                break;
            }
        }
        for (int i = 0; i < 12; i++) {
            if (((scaleMask >> ((pitchInt - i + 12) % 12)) & 1) == 1) {
                distDown = -i;
                break;
            }
        }
        
        float nearestNote = (abs(float(distUp)) < abs(float(distDown))) ? float(distUp) : float(distDown);
        return pitch + nearestNote;
    }

    void main() {
        Coords coords = getCoords(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(coords.dest)) {
            float sourceHz = uvToHz(coords.source.y);
            if (sourceHz < 1.0) { // Avoid processing silence or DC offset
                gl_FragColor = originalTexel;
                return;
            }
            float sourcePitch = hzToMidi(sourceHz);
            
            float quantizedPitch = quantizePitch(sourcePitch);
            
            // Create a target UV with the same time, but the new quantized pitch
            vec2 targetUv = coords.source;
            targetUv.y = hzToUv(midiToHz(quantizedPitch));
            
            // Perform the pitch shift from the source audio to the new target pitch
            vec4 modifiedTexel = sampleSpectrogramTransformed(coords.source, targetUv);

            vec4 mixedTexel = mix(
              sampleSpectrogramPoint(coords.source, packedDataTex, metadataTex, packedTextureSize, numFrames, numBands, sampleRate),
              modifiedTexel,
              amount
            );

            float weight = getFeatherWeight(coords.dest);
            gl_FragColor = applyBrushEffect(originalTexel, mixedTexel, weight);
        } else {
            gl_FragColor = originalTexel;
        }
    }
  `,
);

class HarmonizerBrush extends BaseBrush {
  materials: THREE.ShaderMaterial[];
  parameters: BrushParameter[];

  constructor() {
    super();
    this.materials = [new HarmonizerMaterial()];
    this.parameters = [
      {
        type: "slider",
        atom: harmonizerAmountAtom,
        label: "Amount",
        propName: "amount",
        min: 0,
        max: 1,
        step: 0.01,
        formatValue: (v) => `${(v * 100).toFixed(0)}%`,
      },
    ];
  }

  updateUniforms(props: UpdateUniformsProps, passIndex: number): void {
    super.updateUniforms(props, passIndex);
    const material = this.materials[passIndex];
    if (!material) return;

    material.uniforms.amount.value = store.get(harmonizerAmountAtom);

    const scaleType = store.get(scaleTypeAtom) as keyof typeof scales;
    const scaleMask = scales[scaleType] || scales.Major;
    material.uniforms.scaleMask.value = scaleMask;

    const rootNoteName = store.get(scaleTonicAtom);
    const rootNote = noteNames.indexOf(rootNoteName);
    material.uniforms.rootNote.value = rootNote >= 0 ? rootNote : 0;
  }
}

export const harmonizerBrush = new HarmonizerBrush();
