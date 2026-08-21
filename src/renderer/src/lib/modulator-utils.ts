import { BrushStep, NumberParameter, parameterDefs } from "@renderer/parameters";
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
import {
  isBrushSpanBeats,
  isBrushSpanSemis,
  isGridSpanBeats,
  isGridSpanSemis,
  MAX_SEQ_SIZE,
  MAX_SEQ_STEPS_X,
  MAX_SEQ_STEPS_Y,
  NUM_MODULATORS,
} from "./constants";
import { perfMark } from "./perf-probe";
import { bandIndexToPitchUv, gridCellBeats, gridCellSemis, resolveBrushFootprint, unitsToUv } from "./utils";

// Every step parameter the modulator preview reads is prefixed `modulator<n>` —
// the modulators' own params plus the nested mod/contextual/macro amounts routed
// into them (all generated into parameterDefs with that prefix). Deriving the key
// set from parameterDefs keeps it complete: it cannot silently miss a nested mod
// amount the way a hand-maintained list could. The brush size joins them because
// a rate or loop set to Brush spans it.
const BRUSH_SPAN_KEYS: ParameterKey[] = ["brushSizeTime", "brushSizePitch"];
export const MODULATOR_PREVIEW_KEYS: ParameterKey[] = [
  ...(Object.keys(parameterDefs) as ParameterKey[]).filter((key) => /^modulator\d/.test(key)),
  ...BRUSH_SPAN_KEYS,
];

// Equality over only the step parameters the modulator preview depends on. Used
// as the active-step subscription's equalityFn so the preview rebuild — and the
// shared-canvas invalidate it triggers — fires only when a modulator param
// actually changes, not on every unrelated step-param drag (an effect amount, a
// blend mode). The macro *values* are watched by a separate subscription.
export const modulatorParamsEqual = (a?: BrushStep, b?: BrushStep): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const sa = a as Record<string, unknown>;
  const sb = b as Record<string, unknown>;
  for (const key of MODULATOR_PREVIEW_KEYS) {
    if (sa[key] !== sb[key]) return false;
  }
  return true;
};

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
const seqDataParseCache = new Map<string, { values?: number[][]; off?: boolean[][] }>();

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

  // Create 16x16 Float32Array for seq values. A step switched off reads as 0
  // while keeping its own value in the JSON.
  const valuesData = new Float32Array(MAX_SEQ_SIZE);
  const off = Array.isArray(parsed.off) ? parsed.off : undefined;
  if (parsed.values && Array.isArray(parsed.values)) {
    for (let row = 0; row < Math.min(parsed.values.length, MAX_SEQ_STEPS_Y); row++) {
      const rowData = parsed.values[row];
      if (Array.isArray(rowData)) {
        for (let col = 0; col < Math.min(rowData.length, MAX_SEQ_STEPS_X); col++) {
          valuesData[row * MAX_SEQ_STEPS_X + col] = off?.[row]?.[col] ? 0 : rowData[col] || 0;
        }
      }
    }
  }

  // Create DataTexture (16x16, RedFormat, FloatType)
  const seqDataTex = new DataTexture(valuesData, MAX_SEQ_STEPS_X, MAX_SEQ_STEPS_Y, RedFormat, FloatType);
  seqDataTex.needsUpdate = true;

  return seqDataTex;
}

// Sequencer value index in MODULATOR_MODES (Pattern, Envelope, Sequencer).
const SEQUENCER_MODE = 2;

// Sequencer value textures keyed by their serialized data, so a paint drag
// reuses one GPU texture instead of allocating (and leaking) a fresh one every
// step. The data string only changes when the user edits the sequencer, so the
// map stays tiny. Modulators not in sequencer mode never sample this texture, so
// they all share a single empty placeholder.
const seqDataTexCache = new Map<string, DataTexture>();
let emptySeqDataTex: DataTexture | null = null;

function getSeqDataTexture(mode: number, seqDataStr: string): DataTexture {
  if (mode !== SEQUENCER_MODE) {
    if (!emptySeqDataTex) emptySeqDataTex = createSeqDataTexture("{}");
    return emptySeqDataTex;
  }
  let tex = seqDataTexCache.get(seqDataStr);
  if (!tex) {
    tex = createSeqDataTexture(seqDataStr);
    seqDataTexCache.set(seqDataStr, tex);
  }
  return tex;
}

/**
 * Resolves a span parameter — a modulator rate or a sequencer loop — into a UV
 * size on each axis. The Grid and Brush sentinels take the size of one grid cell
 * or of the brush itself, so they track those as they change.
 */
function createSpanResolver(
  state: State,
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
) {
  const gridUv = unitsToUv(
    gridCellBeats(state.gridSizeBeats),
    gridCellSemis(state.gridSizeSemis),
    bpm,
    totalDuration,
    bandsPerOctave,
    numBands,
  );
  const brushUv = resolveBrushFootprint({
    brushSizeTime: state.brushSizeTime,
    brushSizePitch: state.brushSizePitch,
    gridSizeBeats: state.gridSizeBeats,
    gridSizeSemis: state.gridSizeSemis,
    bpm,
    totalDuration,
    bandsPerOctave,
    numBands,
  }).sizeUv;

  return {
    uvX: (beats: number): number => {
      if (isGridSpanBeats(beats)) return gridUv.x;
      if (isBrushSpanBeats(beats)) return brushUv.x;
      return unitsToUv(beats, 0, bpm, totalDuration, bandsPerOctave, numBands).x;
    },
    uvY: (semis: number): number => {
      if (isGridSpanSemis(semis)) return gridUv.y;
      if (isBrushSpanSemis(semis)) return brushUv.y;
      return unitsToUv(0, semis, bpm, totalDuration, bandsPerOctave, numBands).y;
    },
  };
}

export const buildModulatorUniforms = (
  bpm: number,
  totalDuration: number,
  bandsPerOctave: number,
  numBands: number,
  stateOverride?: State,
) =>
  perfMark("buildModulatorUniforms", () => {
    const state = stateOverride ?? useStore.getState();
    const span = createSpanResolver(state, bpm, totalDuration, bandsPerOctave, numBands);
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

      const modulatorPatternRate = { x: span.uvX(rateBeats), y: span.uvY(rateSemis) };

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
          contextualModAmounts: getContextualModAmountsNormalized(
            state,
            `modulator${i + 1}StereoSpread` as ParameterKey,
          ),
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
          return {
            value: span.uvY(loopSemis),
            minValue: span.uvY(loopSemisDef?.min || 1),
            maxValue: span.uvY(loopSemisDef?.max || 96),
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
          return {
            value: span.uvX(loopBeats),
            minValue: span.uvX(loopBeatsDef?.min || 1 / 64),
            maxValue: span.uvX(loopBeatsDef?.max || 32),
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
          return getSeqDataTexture(mode, seqDataStr);
        })(),
      });
    }

    return modulators;
  });

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
      const v = bandIndexToPitchUv(i + 0.5, numBands);
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
