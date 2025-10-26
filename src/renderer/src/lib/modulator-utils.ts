import { NumberParameter, parameterDefs } from "@renderer/parameters";
import { openFiles } from "@renderer/store/files";
import { useMemo } from "react";
import { DataTexture, FloatType, RedFormat } from "three";
import { Note, Scale } from "tonal";
import { useStore } from "../store";
import { NUM_MODULATORS } from "./constants";
import { unitsToUv } from "./utils";

export const buildModulatorUniforms = (
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
) => {
  const state = useStore.getState();
  const modulators = Array.from({ length: NUM_MODULATORS }).map((_, i) => {
    const mode = state[`modulator${i + 1}Mode`] as number;
    const shape = state[`modulator${i + 1}PatternShape`] as number;
    const phaseMode = state[`modulator${i + 1}PhaseMode`] as number;
    const rateBeats = state[`modulator${i + 1}PatternRateBeats`] as number;
    const rateSemis = state[`modulator${i + 1}PatternRateSemis`] as number;
    const strength = state[`modulator${i + 1}Strength`] as number;
    const rotation = state[`modulator${i + 1}Rotation`] as number;
    const envelopeMinDb = state[`modulator${i + 1}EnvelopeMinDb`] as number;
    const envelopeMaxDb = state[`modulator${i + 1}EnvelopeMaxDb`] as number;

    const modulatorPatternRate = unitsToUv(rateBeats, rateSemis, bpm, totalDuration, bandsPerOctave, numBands);

    const rateBeatsDef = parameterDefs[`modulator${i + 1}PatternRateBeats`] as NumberParameter;
    const rateSemisDef = parameterDefs[`modulator${i + 1}PatternRateSemis`] as NumberParameter;
    const strengthDef = parameterDefs[`modulator${i + 1}Strength`] as NumberParameter;
    const rotationDef = parameterDefs[`modulator${i + 1}Rotation`] as NumberParameter;

    const maxRateUv = unitsToUv(rateBeatsDef.max, rateSemisDef.max, bpm, totalDuration, bandsPerOctave, numBands);

    return {
      modulatorMode: mode,
      modulatorPatternShape: shape,
      modulatorPhaseMode: phaseMode,
      modulatorPatternRateX: {
        value: modulatorPatternRate.x,
        minValue: 0.0,
        maxValue: maxRateUv.x,
        modulationAmounts: rateBeatsDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
      },
      modulatorPatternRateY: {
        value: modulatorPatternRate.y,
        minValue: 0.0,
        maxValue: maxRateUv.y,
        modulationAmounts: rateSemisDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
      },
      modulatorStrength: {
        value: strength / 100,
        minValue: 0.0,
        maxValue: 1.0,
        modulationAmounts: strengthDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
      },
      modulatorRotation: {
        value: rotation,
        minValue: rotationDef.min,
        maxValue: rotationDef.max,
        modulationAmounts: rotationDef.modulatorParamKeys?.map((paramKey) => (state[paramKey] as number) / 100) || [],
      },
      modulatorEnvelopeMinDb: envelopeMinDb,
      modulatorEnvelopeMaxDb: envelopeMaxDb,
    };
  });

  return modulators;
};

export const useModulatorScaleLut = (fileId: string) => {
  const bandsPerOctave = useStore((state) => state.bandsPerOctave);
  const minFreq = useStore((state) => state.minFreq);
  const scaleTonic = useStore((state) => state.scaleTonic);
  const scaleType = useStore((state) => state.scaleType);

  const file = openFiles[fileId];
  const spectrogramData = file?.spectrogramData;
  const numBands = spectrogramData?.numBands;

  return useMemo(() => {
    if (!spectrogramData || !numBands) return null;

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
  }, [bandsPerOctave, minFreq, scaleTonic, scaleType, numBands, spectrogramData]);
};
