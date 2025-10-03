import { DataTexture, FloatType, RedFormat } from "three";
import { Note, Scale } from "tonal";
import { openFiles, useStore } from "../store";

export const useModulatorScaleLut = (filePath: string) => {
  const bandsPerOctave = useStore((state) => state.bandsPerOctave.value);
  const minFreq = useStore((state) => state.minFreq.value);
  const scaleTonic = useStore((state) => state.scaleTonic.value);
  const scaleType = useStore((state) => state.scaleType.value);

  const file = openFiles[filePath];
  const spectrogramData = file?.spectrogramData;
  if (!spectrogramData) return null;

  const { numBands } = spectrogramData;

  const scale = Scale.get(`${scaleTonic} ${scaleType}`);
  const chroma = scale.chroma
    .split("")
    .map(Number)
    .filter((n) => !isNaN(n));

  if (chroma.length !== 12) return null;

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

    gainLutData[i] = isInScale;
  }

  const lut = new DataTexture(gainLutData, numBands, 1, RedFormat, FloatType);
  lut.needsUpdate = true;
  return lut;
};
