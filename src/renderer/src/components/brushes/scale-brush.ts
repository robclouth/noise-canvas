import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import { DataTexture, FloatType, RedFormat, ShaderMaterial } from "three";
import { Note, Scale } from "tonal";
import {
  bandsPerOctaveAtom,
  minFreqAtom,
  scaleTonicAtom,
  scaleTypeAtom,
  spectrogramDataAtom,
  store,
} from "../../store";
import { BaseBrush, BrushParameter } from "./base-brush";
import { brushMain, code, CommonUniforms, defaultValues, vertexShader } from "./common";

export const scaleAmountAtom = atomWithStorage("scaleAmount", 100);

const ScaleMaterial = shaderMaterial(
  {
    ...defaultValues,
    gainLut: null,
  },
  vertexShader,
  /*glsl*/ `
    uniform sampler2D gainLut;

    ${code}

    vec4 applyBrushStroke(vec4 sourceTexel, Coords coords) {
      float bandIndex = floor((1.0 - coords.dest.y) * sourceBandCount);
      vec2 lutUv = vec2((bandIndex + 0.5) / sourceBandCount, 0.5);
      float gainFactor = texture2D(gainLut, lutUv).r;
      
      return sourceTexel * gainFactor;
    }

    ${brushMain}
  `,
);

class ScaleBrush extends BaseBrush {
  materials: ShaderMaterial[];
  parameters: BrushParameter[];
  gainLut: DataTexture | null = null;

  constructor() {
    super();
    this.materials = [new ScaleMaterial()];
    this.parameters = [
      {
        type: "slider",
        atom: scaleAmountAtom,
        label: "Amount",
        min: -100,
        max: 100,
        step: 1,
        unit: "%",
      },
    ];
  }

  updateUniforms(props: CommonUniforms, passIndex: number): void {
    super.updateUniforms(props, passIndex);
    this.updateGainLut();
    this.materials[passIndex].uniforms.gainLut.value = this.gainLut;
  }

  updateGainLut() {
    const spectrogramData = store.get(spectrogramDataAtom);
    if (!spectrogramData) return;

    const { numBands } = spectrogramData;
    const bandsPerOctave = store.get(bandsPerOctaveAtom);
    const minFreq = store.get(minFreqAtom);
    const scaleAmount = store.get(scaleAmountAtom);
    const tonic = store.get(scaleTonicAtom);
    const type = store.get(scaleTypeAtom);

    const scale = Scale.get(`${tonic} ${type}`);
    const chroma = scale.chroma
      .split("")
      .map(Number)
      .filter((n) => !isNaN(n));

    if (chroma.length !== 12) return;

    const totalOctaves = numBands / bandsPerOctave;
    const referenceMidi = Note.midi("A4") || 69;
    const referenceFreq = Note.freq("A4") || 440;
    const gainLutData = new Float32Array(numBands);

    for (let i = 0; i < numBands; i++) {
      const v = 1.0 - (i + 0.5) / numBands;
      const currentFreq = minFreq * Math.pow(2.0, v * totalOctaves);

      if (currentFreq <= 0) {
        gainLutData[i] = 1.0;
        continue;
      }

      const semitonesFromRef = 12.0 * Math.log2(currentFreq / referenceFreq);
      const midiNote = referenceMidi + semitonesFromRef;
      const chromaIndex = ((Math.round(midiNote) % 12) + 12) % 12;
      const isInScale = chroma[chromaIndex];

      let gainFactor = 1.0;
      if (scaleAmount >= 0) {
        const amount = scaleAmount / 100.0;
        if (isInScale === 0) {
          gainFactor = 1.0 - amount;
        }
      } else {
        const amount = -scaleAmount / 100.0;
        if (isInScale === 1) {
          gainFactor = 1.0 - amount;
        }
      }
      gainLutData[i] = gainFactor;
    }

    if (!this.gainLut || this.gainLut.image.width !== numBands) {
      this.gainLut = new DataTexture(gainLutData, numBands, 1, RedFormat, FloatType);
    } else {
      (this.gainLut.image.data as Float32Array).set(gainLutData);
    }
    this.gainLut.needsUpdate = true;
  }
}

export const scaleBrush = new ScaleBrush();
