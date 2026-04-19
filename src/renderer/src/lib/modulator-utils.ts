import { NumberParameter, parameterDefs } from "@renderer/parameters";
import { openFiles } from "@renderer/store/files";
import {
  getContextualModAmountsNormalized,
  getMacroAmountValuesNormalized,
  getModAmountValuesNormalized,
} from "@renderer/store/modulators";
import { ParameterKey, State } from "@renderer/store/types";
import { useMemo } from "react";
import { DataTexture, FloatType, RedFormat } from "three";
import { Note, Scale } from "tonal";
import { useStore } from "../store";
import { MAX_SEQ_SIZE, MAX_SEQ_STEPS_X, MAX_SEQ_STEPS_Y, NUM_MODULATORS } from "./constants";
import { unitsToUv } from "./utils";

// Type for modulatable parameter with modulation amounts
interface ModulatableParam {
  value: number;
  minValue: number;
  maxValue: number;
  modulationAmounts: number[];
  contextualModAmounts: number[];
  macroAmounts: number[];
}

// Type for a single modulator's uniforms
export interface ModulatorUniform {
  modulatorMode: number;
  modulatorPatternShape: number;
  modulatorPhaseMode: number;
  modulatorPhaseX: ModulatableParam;
  modulatorPhaseY: ModulatableParam;
  modulatorPatternRateX: ModulatableParam;
  modulatorPatternRateY: ModulatableParam;
  modulatorStrength: ModulatableParam;
  modulatorRotation: ModulatableParam;
  modulatorStereoSpread: ModulatableParam;
  modulatorEnvelopeSmoothing: number;
  modulatorEnvelopeSource: number;
  modulatorEnvelopeMinDb: number;
  modulatorEnvelopeMaxDb: number;
  seqStepsX: number;
  seqStepsY: number;
  seqLoopY: ModulatableParam;
  seqSwing: ModulatableParam;
  seqLoopX: ModulatableParam;
  seqDataTex: DataTexture;
}

// Cache for parsed sequencer JSON to avoid repeated parsing
const seqDataParseCache = new Map<string, { values?: number[][] }>();

// Helper to parse sequencer data and create DataTexture
function createSeqDataTexture(seqDataStr: string): DataTexture {
  let parsed = seqDataParseCache.get(seqDataStr);
  if (parsed === undefined) {
    try {
      parsed = JSON.parse(seqDataStr);
    } catch {
      parsed = {};
    }
    seqDataParseCache.set(seqDataStr, parsed!);
  }
  parsed = parsed!;

  // Create 16x16 Float32Array for seq values
  const valuesData = new Float32Array(MAX_SEQ_SIZE);
  if (parsed.values && Array.isArray(parsed.values)) {
    for (let row = 0; row < Math.min(parsed.values.length, MAX_SEQ_STEPS_Y); row++) {
      const rowData = parsed.values[row];
      if (Array.isArray(rowData)) {
        for (let col = 0; col < Math.min(rowData.length, MAX_SEQ_STEPS_X); col++) {
          valuesData[row * MAX_SEQ_STEPS_X + col] = rowData[col] || 0;
        }
      }
    }
  }

  // Create DataTexture (16x16, RedFormat, FloatType)
  const seqDataTex = new DataTexture(valuesData, MAX_SEQ_STEPS_X, MAX_SEQ_STEPS_Y, RedFormat, FloatType);
  seqDataTex.needsUpdate = true;

  return seqDataTex;
}

export const buildModulatorUniforms = (
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
  stateOverride?: State,
) => {
  const state = stateOverride ?? useStore.getState();
  const modulators: ModulatorUniform[] = [];
  for (let i = 0; i < NUM_MODULATORS; i++) {
    const mode = state[`modulator${i + 1}Mode`] as number;
    const shape = state[`modulator${i + 1}PatternShape`] as number;
    const phaseMode = state[`modulator${i + 1}PhaseMode`] as number;
    const phaseX = state[`modulator${i + 1}PhaseX`] as number;
    const phaseY = state[`modulator${i + 1}PhaseY`] as number;
    const rateBeats = state[`modulator${i + 1}PatternRateBeats`] as number;
    const rateSemis = state[`modulator${i + 1}PatternRateSemis`] as number;
    const strength = state[`modulator${i + 1}Strength`] as number;
    const rotation = state[`modulator${i + 1}Rotation`] as number;
    const stereoSpread = state[`modulator${i + 1}StereoSpread`] as number;
    const envelopeSmoothingBeats = state[`modulator${i + 1}EnvelopeSmoothingBeats`] as number;
    const envelopeSource = state[`modulator${i + 1}EnvelopeSource`] as number;
    const envelopeMinDb = state[`modulator${i + 1}EnvelopeMinDb`] as number;
    const envelopeMaxDb = state[`modulator${i + 1}EnvelopeMaxDb`] as number;
    // Convert smoothing beats to UV half-width
    const envelopeSmoothingUv = (envelopeSmoothingBeats * 60) / bpm / totalDuration / 2;

    const modulatorPatternRate = unitsToUv(rateBeats, rateSemis, bpm, totalDuration, bandsPerOctave, numBands);

    const rateBeatsDef = parameterDefs[`modulator${i + 1}PatternRateBeats`] as NumberParameter;
    const rateSemisDef = parameterDefs[`modulator${i + 1}PatternRateSemis`] as NumberParameter;
    const rotationDef = parameterDefs[`modulator${i + 1}Rotation`] as NumberParameter;

    const maxRateUv = unitsToUv(rateBeatsDef.max, rateSemisDef.max, bpm, totalDuration, bandsPerOctave, numBands);

    modulators.push({
      modulatorMode: mode,
      modulatorPatternShape: shape,
      modulatorPhaseMode: phaseMode,
      modulatorPhaseX: {
        value: phaseX / 100,
        minValue: 0.0,
        maxValue: 1.0,
        modulationAmounts: getModAmountValuesNormalized(state, `modulator${i + 1}PhaseX` as ParameterKey),
        contextualModAmounts: getContextualModAmountsNormalized(state, `modulator${i + 1}PhaseX` as ParameterKey),
        macroAmounts: getMacroAmountValuesNormalized(state, `modulator${i + 1}PhaseX` as ParameterKey),
      },
      modulatorPhaseY: {
        value: phaseY / 100,
        minValue: 0.0,
        maxValue: 1.0,
        modulationAmounts: getModAmountValuesNormalized(state, `modulator${i + 1}PhaseY` as ParameterKey),
        contextualModAmounts: getContextualModAmountsNormalized(state, `modulator${i + 1}PhaseY` as ParameterKey),
        macroAmounts: getMacroAmountValuesNormalized(state, `modulator${i + 1}PhaseY` as ParameterKey),
      },
      modulatorPatternRateX: {
        value: modulatorPatternRate.x,
        minValue: 0.0,
        maxValue: maxRateUv.x,
        modulationAmounts: getModAmountValuesNormalized(state, `modulator${i + 1}PatternRateBeats` as ParameterKey),
        contextualModAmounts: getContextualModAmountsNormalized(
          state,
          `modulator${i + 1}PatternRateBeats` as ParameterKey,
        ),
        macroAmounts: getMacroAmountValuesNormalized(state, `modulator${i + 1}PatternRateBeats` as ParameterKey),
      },
      modulatorPatternRateY: {
        value: modulatorPatternRate.y,
        minValue: 0.0,
        maxValue: maxRateUv.y,
        modulationAmounts: getModAmountValuesNormalized(state, `modulator${i + 1}PatternRateSemis` as ParameterKey),
        contextualModAmounts: getContextualModAmountsNormalized(
          state,
          `modulator${i + 1}PatternRateSemis` as ParameterKey,
        ),
        macroAmounts: getMacroAmountValuesNormalized(state, `modulator${i + 1}PatternRateSemis` as ParameterKey),
      },
      modulatorStrength: {
        value: strength / 100,
        minValue: 0.0,
        maxValue: 1.0,
        modulationAmounts: getModAmountValuesNormalized(state, `modulator${i + 1}Strength` as ParameterKey),
        contextualModAmounts: getContextualModAmountsNormalized(state, `modulator${i + 1}Strength` as ParameterKey),
        macroAmounts: getMacroAmountValuesNormalized(state, `modulator${i + 1}Strength` as ParameterKey),
      },
      modulatorRotation: {
        value: rotation,
        minValue: rotationDef.min,
        maxValue: rotationDef.max,
        modulationAmounts: getModAmountValuesNormalized(state, `modulator${i + 1}Rotation` as ParameterKey),
        contextualModAmounts: getContextualModAmountsNormalized(state, `modulator${i + 1}Rotation` as ParameterKey),
        macroAmounts: getMacroAmountValuesNormalized(state, `modulator${i + 1}Rotation` as ParameterKey),
      },
      modulatorStereoSpread: {
        value: stereoSpread / 100,
        minValue: -1.0,
        maxValue: 1.0,
        modulationAmounts: getModAmountValuesNormalized(state, `modulator${i + 1}StereoSpread` as ParameterKey),
        contextualModAmounts: getContextualModAmountsNormalized(state, `modulator${i + 1}StereoSpread` as ParameterKey),
        macroAmounts: getMacroAmountValuesNormalized(state, `modulator${i + 1}StereoSpread` as ParameterKey),
      },
      modulatorEnvelopeSmoothing: envelopeSmoothingUv,
      modulatorEnvelopeSource: envelopeSource,
      modulatorEnvelopeMinDb: envelopeMinDb,
      modulatorEnvelopeMaxDb: envelopeMaxDb,
      // Sequencer parameters
      seqStepsX: (state[`modulator${i + 1}SeqStepsX`] as number) || 8,
      seqStepsY: (state[`modulator${i + 1}SeqStepsY`] as number) || 4,
      seqLoopY: (() => {
        const loopSemis = (state[`modulator${i + 1}SeqLoopSemis`] as number) || 12;
        const loopSemisDef = parameterDefs[`modulator${i + 1}SeqLoopSemis`] as NumberParameter;
        // Convert semitones to UV space
        const loopYUv = loopSemis / (bandsPerOctave * (numBands / bandsPerOctave));
        const maxLoopYUv = (loopSemisDef?.max || 96) / (bandsPerOctave * (numBands / bandsPerOctave));
        return {
          value: loopYUv,
          minValue: 1 / (bandsPerOctave * (numBands / bandsPerOctave)),
          maxValue: maxLoopYUv,
          modulationAmounts: getModAmountValuesNormalized(state, `modulator${i + 1}SeqLoopSemis` as ParameterKey),
          contextualModAmounts: getContextualModAmountsNormalized(
            state,
            `modulator${i + 1}SeqLoopSemis` as ParameterKey,
          ),
          macroAmounts: getMacroAmountValuesNormalized(state, `modulator${i + 1}SeqLoopSemis` as ParameterKey),
        };
      })(),
      seqSwing: {
        value: ((state[`modulator${i + 1}SeqSwing`] as number) || 0) / 100,
        minValue: 0.0,
        maxValue: 1.0,
        modulationAmounts: getModAmountValuesNormalized(state, `modulator${i + 1}SeqSwing` as ParameterKey),
        contextualModAmounts: getContextualModAmountsNormalized(state, `modulator${i + 1}SeqSwing` as ParameterKey),
        macroAmounts: getMacroAmountValuesNormalized(state, `modulator${i + 1}SeqSwing` as ParameterKey),
      },
      seqLoopX: (() => {
        const loopBeats = (state[`modulator${i + 1}SeqLoopBeats`] as number) || 1;
        const loopBeatsDef = parameterDefs[`modulator${i + 1}SeqLoopBeats`] as NumberParameter;
        // Convert beats to UV space
        const seconds = (loopBeats * 60) / bpm;
        const loopXUv = seconds / totalDuration;
        const maxSeconds = ((loopBeatsDef?.max || 32) * 60) / bpm;
        const maxLoopXUv = maxSeconds / totalDuration;
        return {
          value: loopXUv,
          minValue: ((loopBeatsDef?.min || 1 / 64) * 60) / bpm / totalDuration,
          maxValue: maxLoopXUv,
          modulationAmounts: getModAmountValuesNormalized(state, `modulator${i + 1}SeqLoopBeats` as ParameterKey),
          contextualModAmounts: getContextualModAmountsNormalized(
            state,
            `modulator${i + 1}SeqLoopBeats` as ParameterKey,
          ),
          macroAmounts: getMacroAmountValuesNormalized(state, `modulator${i + 1}SeqLoopBeats` as ParameterKey),
        };
      })(),
      seqDataTex: (() => {
        const seqDataStr = (state[`modulator${i + 1}SeqData`] as string) || "{}";
        return createSeqDataTexture(seqDataStr);
      })(),
    });
  }

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
