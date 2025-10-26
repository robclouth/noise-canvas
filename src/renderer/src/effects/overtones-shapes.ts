import { useStore } from "@renderer/store";
import { Scale } from "tonal";

export interface Shape {
  label: string;
  create: (count: number) => number[]; // semitones
}

export const shapes: Record<string, Shape> = {
  logarithmic: {
    label: "Logarithmic",
    create: (count) => Array.from({ length: count }, (_, i) => Math.log2(i + 1) * 12),
  },
  exponential: {
    label: "Exponential",
    create: (count) => Array.from({ length: count }, (_, i) => Math.pow(2, i)),
  },
  octaves: {
    label: "Octaves",
    create: (count) => Array.from({ length: count }, (_, i) => i * 12),
  },
  selectedScale: {
    label: "Selected Scale",
    create: (count) => {
      const state = useStore.getState();
      const scaleTonic = state.scaleTonic;
      const scaleType = state.scaleType;
      const scale = Scale.get(`${scaleTonic} ${scaleType}`);
      const chroma = scale.chroma.split("").map(Number);

      const overtones: number[] = [];

      let octave = 0;
      while (overtones.length < count) {
        for (let i = 0; i < 12; i++) {
          if (chroma[i]) {
            overtones.push(i + octave * 12);
            if (overtones.length >= count) break;
          }
        }
        octave++;
      }
      return overtones;
    },
  },
};
