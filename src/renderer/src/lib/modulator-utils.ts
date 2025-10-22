import { openFiles } from "@renderer/store/files";
import { NumberParameter, OptionsParameter, ParameterKey } from "@renderer/store/types";
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
    const mode = state[`modulator${i + 1}Mode` as ParameterKey] as OptionsParameter<number>;
    const shape = state[`modulator${i + 1}PatternShape` as ParameterKey] as OptionsParameter<number>;
    const phaseMode = state[`modulator${i + 1}PhaseMode` as ParameterKey] as OptionsParameter<number>;
    const rateBeats = state[`modulator${i + 1}PatternRateBeats` as ParameterKey] as NumberParameter;
    const rateSemis = state[`modulator${i + 1}PatternRateSemis` as ParameterKey] as NumberParameter;
    const strength = state[`modulator${i + 1}Strength` as ParameterKey] as NumberParameter;
    const rotation = state[`modulator${i + 1}Rotation` as ParameterKey] as NumberParameter;
    const envelopeMinDb = state[`modulator${i + 1}EnvelopeMinDb` as ParameterKey] as NumberParameter;
    const envelopeMaxDb = state[`modulator${i + 1}EnvelopeMaxDb` as ParameterKey] as NumberParameter;

    const modulatorPatternRate = unitsToUv(
      rateBeats.value,
      rateSemis.value,
      bpm,
      totalDuration,
      bandsPerOctave,
      numBands,
    );

    const maxRateUv = unitsToUv(rateBeats.max, rateSemis.max, bpm, totalDuration, bandsPerOctave, numBands);

    return {
      modulatorMode: mode.value,
      modulatorPatternShape: shape.value,
      modulatorPhaseMode: phaseMode.value,
      modulatorPatternRateX: {
        value: modulatorPatternRate.x,
        minValue: 0.0,
        maxValue: maxRateUv.x,
        modulationAmounts: rateBeats.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
      },
      modulatorPatternRateY: {
        value: modulatorPatternRate.y,
        minValue: 0.0,
        maxValue: maxRateUv.y,
        modulationAmounts: rateSemis.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
      },
      modulatorStrength: {
        value: strength.value / 100,
        minValue: 0.0,
        maxValue: 1.0,
        modulationAmounts: strength.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
      },
      modulatorRotation: {
        value: rotation.value,
        minValue: rotation.min,
        maxValue: rotation.max,
        modulationAmounts: rotation.modulatorParamKeys?.map((paramKey) => state[paramKey].value / 100) || [],
      },
      modulatorEnvelopeMinDb: envelopeMinDb.value,
      modulatorEnvelopeMaxDb: envelopeMaxDb.value,
    };
  });

  return modulators;
};

export const useModulatorScaleLut = (fileId: string) => {
  const bandsPerOctave = useStore((state) => state.bandsPerOctave.value);
  const minFreq = useStore((state) => state.minFreq.value);
  const scaleTonic = useStore((state) => state.scaleTonic.value);
  const scaleType = useStore((state) => state.scaleType.value);

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
