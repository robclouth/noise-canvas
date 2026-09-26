import { BRUSH_SPAN_BEATS_VALUE } from "./constants";
import { CURRENT_PRESET_VERSION, PresetType } from "./preset-schema";
import type { ParameterKey } from "../store/types";
import { normalizeParameterValue } from "../store/utils";

// A `<param>ModMacroNAmount` of 100 makes the macro knob sweep that parameter
// along its slider, replacing the base value; a negative amount runs the sweep
// the other way. `park` returns the knob position that lands a fully swept
// parameter on a value.
//
// Two families sweep a shader range rather than their slider, so they are parked
// as plain numbers instead: a source offset reads the whole file either way from
// 50, and a blur size runs from nothing to a tenth of the file.
const park = (paramKey: ParameterKey, value: number): number => normalizeParameterValue(paramKey, value) * 100;

export const factoryPresets: PresetType[] = [
  // Macro 1 sets the level the erased region drops to; 0 is a clean wipe.
  {
    id: "eraser",
    name: "Eraser",
    color: { hue: "red", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "eraser-step-1",
        name: "Step 1",
        effects: [
          {
            id: "eraser-dynamics",
            effect: "dynamics",
            enabled: true,
            params: { dynamicsGainDb: -80, dynamicsGainDbModMacro1Amount: 100 },
          },
        ],
      },
    ],
    linkedParams: [],
    macroNames: ["Level", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [park("dynamicsGainDb", -80), 50, 50, 50],
  },
  // Macro 1 is a full-range gain knob, parked at +6 dB.
  {
    id: "booster",
    name: "Booster",
    color: { hue: "red", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "booster-step-1",
        name: "Step 1",
        effects: [
          {
            id: "booster-dynamics",
            effect: "dynamics",
            enabled: true,
            params: { dynamicsGainDb: 6, dynamicsGainDbModMacro1Amount: 100 },
          },
        ],
      },
    ],
    linkedParams: [],
    macroNames: ["Gain", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [park("dynamicsGainDb", 6), 50, 50, 50],
  },
  // Macro 1 blends the restored original against the current state.
  {
    id: "restore",
    name: "Restore",
    color: { hue: "teal", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "restore-step-1",
        name: "Step 1",
        effects: [],
        sourceDataMode: "original",
        blendMode: 0,
        brushIntensityModMacro1Amount: 100,
      },
    ],
    linkedParams: [],
    macroNames: ["Amount", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [park("brushIntensity", 100), 50, 50, 50],
  },
  // Macro 1 blends the pan movement in, from untouched to full width.
  {
    id: "stereo-widening",
    name: "Stereo Widening",
    color: { hue: "cyan", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "stereo-widening-step-1",
        name: "Step 1",
        effects: [],
        brushPanMod1Amount: 100,
        modulator1PatternRateBeats: 4,
        brushIntensityModMacro1Amount: 100,
      },
    ],
    linkedParams: [],
    macroNames: ["Width", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [park("brushIntensity", 100), 50, 50, 50],
  },

  // --- Dynamics ---
  // Tames loud regions: gentle compression above threshold with makeup gain. Broadband, full-height brush.
  // Macro 1 blends the compressed signal in parallel; Macro 2 moves the threshold, Macro 3 the ratio.
  {
    id: "compressor",
    name: "Compressor",
    color: { hue: "red", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "compressor-step-1",
        name: "Step 1",
        effects: [
          {
            id: "compressor-dynamics",
            effect: "dynamics",
            enabled: true,
            params: {
              dynamicsThresholdDb: -24,
              dynamicsThresholdDbModMacro2Amount: 100,
              dynamicsUpperRatio: 0.4,
              dynamicsUpperRatioModMacro3Amount: 100,
              dynamicsKnee: 12,
              dynamicsGainDb: 3,
            },
          },
        ],
        brushIntensityModMacro1Amount: 100,
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Amount", "Threshold", "Ratio", "Macro 4"],
    macroValues: [park("brushIntensity", 100), park("dynamicsThresholdDb", -24), park("dynamicsUpperRatio", 0.4), 50],
  },
  // Silences anything below the threshold to clean up hiss and bleed between sounds.
  // Macro 1 raises the threshold to gate harder, Macro 2 softens the knee.
  {
    id: "noise-gate",
    name: "Noise Gate",
    color: { hue: "red", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "noise-gate-step-1",
        name: "Step 1",
        effects: [
          {
            id: "noise-gate-dynamics",
            effect: "dynamics",
            enabled: true,
            params: {
              dynamicsThresholdDb: -45,
              dynamicsThresholdDbModMacro1Amount: 100,
              dynamicsLowerRatio: 0,
              dynamicsKnee: 6,
              dynamicsKneeModMacro2Amount: 100,
            },
          },
        ],
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Threshold", "Knee", "Macro 3", "Macro 4"],
    macroValues: [park("dynamicsThresholdDb", -45), park("dynamicsKnee", 6), 50, 50],
  },
  // Accumulate makes overlapping dabs re-blur the already-blurred result, so dragging smears content around.
  // Macro 1 drives both blur axes at once.
  {
    id: "smudge",
    name: "Smudge",
    color: { hue: "green", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "smudge-step-1",
        name: "Step 1",
        effects: [
          {
            id: "smudge-blur",
            effect: "blur",
            enabled: true,
            params: {
              blurAmountTime: 50,
              blurAmountTimeModMacro1Amount: 100,
              blurAmountPitch: 50,
              blurAmountPitchModMacro1Amount: 100,
              blurSamplesX: 12,
              blurSamplesY: 12,
            },
          },
        ],
        accumulate: true,
        brushSizeTime: 1,
        brushSizePitch: 36,
        brushCurveTime: -40,
        brushCurvePitch: -40,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Smear", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [20, 50, 50, 50],
  },

  // --- Transform ---
  // Shifts content up one octave within the brush. Macro 1 fades the shifted copy in.
  {
    id: "octave-up",
    name: "Octave Up",
    color: { hue: "violet", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "octave-up-step-1",
        name: "Step 1",
        effects: [
          { id: "octave-up-transform", effect: "transform", enabled: true, params: { transformShiftSemis: 12 } },
        ],
        brushIntensityModMacro1Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Blend", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [park("brushIntensity", 100), 50, 50, 50],
  },
  // Shifts content down one octave within the brush. Macro 1 fades the shifted copy in.
  {
    id: "octave-down",
    name: "Octave Down",
    color: { hue: "violet", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "octave-down-step-1",
        name: "Step 1",
        effects: [
          { id: "octave-down-transform", effect: "transform", enabled: true, params: { transformShiftSemis: -12 } },
        ],
        brushIntensityModMacro1Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Blend", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [park("brushIntensity", 100), 50, 50, 50],
  },
  // Mirrors the painted window in time. Cut edges keep neighbouring audio out of the reversed chunk.
  // Macro 1 is a varispeed knob: backwards through freeze to forwards, parked at -1x.
  {
    id: "reverse",
    name: "Reverse",
    color: { hue: "orange", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "reverse-step-1",
        name: "Step 1",
        effects: [
          {
            id: "reverse-transform",
            effect: "transform",
            enabled: true,
            params: { transformScaleTime: -1, transformScaleTimeModMacro1Amount: 100, transformEdgeMode: 0 },
          },
        ],
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Speed", "Blend", "Macro 3", "Macro 4"],
    macroValues: [park("transformScaleTime", -1), park("brushIntensity", 100), 50, 50],
  },
  // Tape varispeed: pitch and length move together, parked an octave down at double length.
  // Macro 1 is the platter speed.
  {
    id: "resample",
    name: "Resample",
    color: { hue: "orange", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "resample-step-1",
        name: "Step 1",
        effects: [
          {
            id: "resample-transform",
            effect: "transform",
            enabled: true,
            params: { transformSpeed: 0.5, transformSpeedModMacro1Amount: 100, transformEdgeMode: 0 },
          },
        ],
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Speed", "Blend", "Macro 3", "Macro 4"],
    macroValues: [park("transformSpeed", 0.5), park("brushIntensity", 100), 50, 50],
  },
  // Scales the pitch axis about the brush centre, so harmonics spread apart or collapse
  // together while the timing stays put. Macro 1 is the spread.
  {
    id: "frequency-stretch",
    name: "Frequency Stretch",
    color: { hue: "violet", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "frequency-stretch-step-1",
        name: "Step 1",
        effects: [
          {
            id: "frequency-stretch-transform",
            effect: "transform",
            enabled: true,
            params: {
              transformScalePitch: 1.5,
              transformScalePitchModMacro1Amount: 100,
              transformOriginPitch: 1,
              transformEdgeMode: 0,
            },
          },
        ],
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Spread", "Blend", "Macro 3", "Macro 4"],
    macroValues: [park("transformScalePitch", 1.5), park("brushIntensity", 100), 50, 50],
  },
  // A sawtooth spanning the brush drives the pitch shift, so one stroke is one sweep.
  // Macro 1 is the sweep depth: centre is flat, above rises, below falls.
  {
    id: "pitch-ramp",
    name: "Pitch Ramp",
    color: { hue: "yellow", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "pitch-ramp-step-1",
        name: "Step 1",
        effects: [
          {
            id: "pitch-ramp-transform",
            effect: "transform",
            enabled: true,
            params: { transformShiftSemis: 0, transformShiftSemisMod1Amount: 100, transformEdgeMode: 1 },
          },
        ],
        modulator1Mode: 0,
        modulator1PatternShape: 3,
        modulator1PatternRateBeats: BRUSH_SPAN_BEATS_VALUE,
        modulator1PatternRateSemis: 0,
        modulator1PhaseMode: 1,
        modulator1Strength: 25,
        modulator1StrengthModMacro1Amount: 100,
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Sweep", "Blend", "Macro 3", "Macro 4"],
    macroValues: [park("modulator1Strength", 25), park("brushIntensity", 100), 50, 50],
  },

  // --- Classic filters ---
  // Dynamics cut weighted toward the top of the spectrum (a low-pass tilt), with the emphasis swept by a sine LFO.
  // Macro 1 moves the tilt point like a cutoff, Macro 2 deepens the cut.
  {
    id: "low-pass-sweep",
    name: "Low-Pass Sweep",
    color: { hue: "yellow", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "low-pass-sweep-step-1",
        name: "Step 1",
        effects: [
          {
            id: "low-pass-sweep-dynamics",
            effect: "dynamics",
            enabled: true,
            params: { dynamicsGainDb: -40, dynamicsGainDbModMacro2Amount: 100 },
          },
        ],
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: -40,
        brushSkewPitch: 70,
        brushSkewPitchMod1Amount: 30,
        brushSkewPitchModMacro1Amount: 70,
        modulator1Mode: 0,
        modulator1PatternShape: 0,
        modulator1PatternRateBeats: 4,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    // The LFO holds 30% of the tilt, so Cutoff sweeps the other 70% around it.
    macroNames: ["Cutoff", "Depth", "Macro 3", "Macro 4"],
    macroValues: [100, park("dynamicsGainDb", -40), 50, 50],
  },
  // Dynamics cut weighted toward the bottom of the spectrum: a static high-pass / low-cut.
  // Macro 1 leans the cut from the lows to the highs, morphing it toward a low-pass; Macro 2 deepens it.
  {
    id: "high-pass",
    name: "High-Pass",
    color: { hue: "yellow", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "high-pass-step-1",
        name: "Step 1",
        effects: [
          {
            id: "high-pass-dynamics",
            effect: "dynamics",
            enabled: true,
            params: { dynamicsGainDb: -40, dynamicsGainDbModMacro2Amount: 100 },
          },
        ],
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: -40,
        brushSkewPitch: -100,
        brushSkewPitchModMacro1Amount: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Tilt", "Depth", "Macro 3", "Macro 4"],
    macroValues: [park("brushSkewPitch", -100), park("dynamicsGainDb", -40), 50, 50],
  },

  // --- Harmonics ---
  // Stacks a decaying harmonic series on top of the painted material to thicken a tone.
  // Macro 1 fades the upper partials, Macro 2 blends the stack in, Macro 3 spaces it.
  {
    id: "harmonics",
    name: "Harmonics",
    color: { hue: "indigo", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "harmonics-step-1",
        name: "Step 1",
        effects: [
          {
            id: "harmonics-clone",
            effect: "clone",
            enabled: true,
            params: {
              cloneCountX: 0,
              cloneCountY: 15,
              cloneSpaceBeats: 0,
              cloneSpaceSemis: 12,
              cloneSpaceSemisModMacro3Amount: 100,
              cloneShapeY: "harmonic",
              cloneDirectionY: 0,
              cloneDecay: 40,
              cloneDecayModMacro1Amount: 100,
            },
          },
        ],
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 24,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Fade", "Blend", "Gap", "Macro 4"],
    macroValues: [park("cloneDecay", 40), park("brushIntensity", 100), park("cloneSpaceSemis", 12), 50],
  },

  // --- Blur ---
  // Smears energy forward in time (origin Left) into a reverb-like tail. Add blend layers the tail over the dry sound.
  // Macro 1 sets the tail length, Macro 2 the wet level, Macro 3 roughens the smear.
  {
    id: "reverb",
    name: "Reverb",
    color: { hue: "cyan", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "reverb-step-1",
        name: "Step 1",
        effects: [
          {
            id: "reverb-blur",
            effect: "blur",
            enabled: true,
            params: {
              blurAmountTime: 100,
              blurAmountTimeModMacro1Amount: 100,
              blurAmountPitch: 0,
              blurNoiseTime: 0,
              blurNoiseTimeModMacro3Amount: 100,
              blurSamplesX: 48,
              blurOrigin: 0,
            },
          },
        ],
        brushSizeTime: 6,
        brushSizePitch: 128,
        brushCurveTime: -40,
        brushCurvePitch: 100,
        brushSkewTime: -100,
        brushAnchorMode: 0,
        brushIterations: 2,
        brushIntensity: 80,
        brushIntensityModMacro2Amount: 100,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Size", "Mix", "Grain", "Macro 4"],
    macroValues: [30, park("brushIntensity", 80), 0, 50],
  },

  // --- Clone ---
  // Beat-spaced decaying copies extending forward in time: a rhythmic delay.
  // Macro 1 fades the repeats, Macro 2 blends them in, Macro 3 spaces them.
  {
    id: "echo",
    name: "Echo",
    color: { hue: "teal", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "echo-step-1",
        name: "Step 1",
        effects: [
          {
            id: "echo-clone",
            effect: "clone",
            enabled: true,
            params: {
              cloneSpaceBeats: 0.5,
              cloneSpaceBeatsModMacro3Amount: 100,
              cloneCountX: 4,
              cloneCountY: 0,
              cloneDecay: 50,
              cloneDecayModMacro1Amount: 100,
              cloneDirectionX: 0,
            },
          },
        ],
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 4,
        brushSizePitch: 48,
        brushCurveTime: -50,
        brushSkewTime: -100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Fade", "Blend", "Time", "Macro 4"],
    macroValues: [park("cloneDecay", 55), park("brushIntensity", 100), park("cloneSpaceBeats", 0.5), 50],
  },

  // --- Synthesize ---
  // Draws broadband noise with a soft, rounded 2D envelope for air and texture.
  // Macro 1 sets the level, Macro 2 hardens the envelope's edges.
  {
    id: "paint-noise",
    name: "Paint Noise",
    color: { hue: "green", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "paint-noise-step-1",
        name: "Step 1",
        effects: [{ id: "paint-noise-synth", effect: "synthesize", enabled: true, params: { synthesizeBrushType: 0 } }],
        brushIntensityModMacro1Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 36,
        brushCurveTime: -60,
        brushCurveTimeModMacro2Amount: 100,
        brushCurvePitch: -60,
        brushCurvePitchModMacro2Amount: 100,
        brushSkewTime: 0,
        brushSkewPitch: 0,
        brushAnchorMode: 1,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Level", "Edge", "Macro 3", "Macro 4"],
    macroValues: [park("brushIntensity", 100), park("brushCurveTime", -60), 50, 50],
  },
  // Draws a single-semitone sine note with a sharp attack and long release.
  // Macro 1 sets the level, Macro 2 stretches the release into a sustain.
  {
    id: "paint-tone",
    name: "Paint Tone",
    color: { hue: "pink", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "paint-tone-step-1",
        name: "Step 1",
        effects: [{ id: "paint-tone-synth", effect: "synthesize", enabled: true, params: { synthesizeBrushType: 1 } }],
        brushIntensityModMacro1Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 1,
        brushCurveTime: -40,
        brushCurveTimeModMacro2Amount: 100,
        brushCurvePitch: 100,
        brushSkewTime: -100,
        brushSkewPitch: 0,
        brushAnchorMode: 0,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Level", "Sustain", "Macro 3", "Macro 4"],
    macroValues: [park("brushIntensity", 100), park("brushCurveTime", -40), 50, 50],
  },

  // --- Evolve ---
  // Reaction-advection-diffusion run over several iterations for a flowing, smoke-like smear.
  // Accumulate keeps a drag pushing the simulation further. Macro 1 drives the current, Macro 2 curls it.
  {
    id: "flow",
    name: "Flow",
    color: { hue: "orange", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "flow-step-1",
        name: "Step 1",
        effects: [
          {
            id: "flow-evolve",
            effect: "evolve",
            enabled: true,
            params: {
              evolveFlow: 40,
              evolveFlowModMacro1Amount: 100,
              evolveSpread: 30,
              evolveSwirl: 20,
              evolveSwirlModMacro2Amount: 100,
              evolveScaleX: 50,
              evolveScaleY: 50,
            },
          },
        ],
        accumulate: true,
        brushSizeTime: 3,
        brushSizePitch: 96,
        brushCurveTime: 60,
        brushCurvePitch: 60,
        brushAnchorMode: 1,
        brushIterations: 8,
      },
    ],
    linkedParams: [],
    macroNames: ["Motion", "Swirl", "Macro 3", "Macro 4"],
    macroValues: [park("evolveFlow", 40), park("evolveSwirl", 20), 50, 50],
  },

  // --- Sort ---
  // Many iterations of magnitude sorting smear bins into vertical streaks for a glitch aesthetic.
  // Macro 1 blends the sorted result against the dry signal.
  {
    id: "pixel-sort",
    name: "Pixel Sort",
    color: { hue: "pink", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "pixel-sort-step-1",
        name: "Step 1",
        effects: [
          {
            id: "pixel-sort-sort",
            effect: "sort",
            enabled: true,
            params: { sortBy: 0, sortDirection: 0, sortOrder: 0, sortStereoMode: 0 },
          },
        ],
        brushIntensityModMacro1Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 96,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
        brushIterations: 5,
        accumulate: true,
      },
    ],
    linkedParams: [],
    macroNames: ["Strength", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [park("brushIntensity", 100), 50, 50, 50],
  },

  // --- Modulation showcases ---
  // A sine LFO fades a fixed dip in and out, so the level breathes without ever boosting.
  // Macro 1 sets the level the dips reach, Macro 2 how far the LFO swings.
  {
    id: "tremolo",
    name: "Tremolo",
    color: { hue: "grape", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "tremolo-step-1",
        name: "Step 1",
        effects: [
          {
            id: "tremolo-dynamics",
            effect: "dynamics",
            enabled: true,
            params: { dynamicsGainDb: -24, dynamicsGainDbModMacro1Amount: 100 },
          },
        ],
        brushIntensityMod1Amount: 100,
        modulator1Mode: 0,
        modulator1PatternShape: 0,
        modulator1PatternRateBeats: 0.5,
        modulator1StrengthModMacro2Amount: 100,
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Dip", "Depth", "Macro 3", "Macro 4"],
    macroValues: [park("dynamicsGainDb", -24), park("modulator1Strength", 100), 50, 50],
  },
  // A step sequencer gates an erase in and out: sounding cells are the zeros, silent cells the ones.
  // Macro 1 sets the level the gated cells drop to, Macro 2 how deep the gate cuts.
  {
    id: "step-gate",
    name: "Step Gate",
    color: { hue: "grape", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "step-gate-step-1",
        name: "Step 1",
        effects: [
          {
            id: "step-gate-dynamics",
            effect: "dynamics",
            enabled: true,
            params: { dynamicsGainDb: -80, dynamicsGainDbModMacro1Amount: 100 },
          },
        ],
        brushIntensityMod1Amount: 100,
        modulator1Mode: 2,
        modulator1SeqStepsX: 8,
        modulator1SeqStepsY: 1,
        modulator1SeqLoopBeats: 2,
        modulator1SeqData: JSON.stringify({ values: [[0, 1, 0, 0, 1, 0, 0, 1]] }),
        modulator1StrengthModMacro2Amount: 100,
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Floor", "Depth", "Macro 3", "Macro 4"],
    macroValues: [park("dynamicsGainDb", -80), park("modulator1Strength", 100), 50, 50],
  },
  // Envelope-follower modulator tracks amplitude and opens a blur on the loudest material.
  // Macro 1 scales how far the follower opens the blur, Macro 2 blends the result in.
  {
    id: "dynamic-bloom",
    name: "Dynamic Bloom",
    color: { hue: "red", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "dynamic-bloom-step-1",
        name: "Step 1",
        effects: [
          {
            id: "dynamic-bloom-blur",
            effect: "blur",
            enabled: true,
            params: { blurAmountTime: 0, blurSamplesX: 32, blurOrigin: 1, blurAmountTimeMod1Amount: 100 },
          },
        ],
        modulator1Mode: 1,
        modulator1EnvelopeSource: 0,
        modulator1EnvelopeMinDb: -50,
        modulator1EnvelopeMaxDb: 0,
        modulator1StrengthModMacro1Amount: 100,
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 3,
        brushSizePitch: 96,
        brushCurveTime: 60,
        brushCurvePitch: 60,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Amount", "Mix", "Macro 3", "Macro 4"],
    macroValues: [park("modulator1Strength", 100), park("brushIntensity", 100), 50, 50],
  },
  // Binaural azimuth swept by a sine LFO so the source orbits the listener.
  // Macro 1 pushes the source away, Macro 2 narrows its stereo image.
  {
    id: "3d-orbit",
    name: "3D Orbit",
    color: { hue: "cyan", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "3d-orbit-step-1",
        name: "Step 1",
        effects: [
          {
            id: "3d-orbit-binaural",
            effect: "binaural",
            enabled: true,
            params: {
              binauralAzimuth: 0,
              binauralDistance: 2,
              binauralDistanceModMacro1Amount: 100,
              binauralStereoAngleModMacro2Amount: 100,
              binauralAzimuthMod1Amount: 100,
            },
          },
        ],
        modulator1Mode: 0,
        modulator1PatternShape: 0,
        modulator1PatternRateBeats: 4,
        brushSizeTime: 8,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Distance", "Width", "Macro 3", "Macro 4"],
    macroValues: [park("binauralDistance", 2), park("binauralStereoAngle", 180), 50, 50],
  },

  // --- Effect chaining ---
  // Octave-up clone feeding a forward blur, repeated, builds a rising shimmer tail.
  // Macro 1 sets the tail length, Macro 2 fades the octave copies.
  {
    id: "shimmer",
    name: "Shimmer",
    color: { hue: "indigo", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "shimmer-step-1",
        name: "Step 1",
        effects: [
          {
            id: "shimmer-clone",
            effect: "clone",
            enabled: true,
            params: {
              cloneSpaceSemis: 12,
              cloneCountX: 0,
              cloneCountY: 1,
              cloneDirectionY: 0,
              cloneDecay: 20,
              cloneDecayModMacro2Amount: 100,
            },
          },
          {
            id: "shimmer-blur",
            effect: "blur",
            enabled: true,
            params: { blurAmountTime: 80, blurAmountTimeModMacro1Amount: 100, blurSamplesX: 40, blurOrigin: 0 },
          },
        ],
        brushSizeTime: 6,
        brushSizePitch: 128,
        brushCurveTime: -40,
        brushSkewTime: -100,
        brushAnchorMode: 0,
        brushIterations: 3,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Tail", "Fade", "Macro 3", "Macro 4"],
    macroValues: [40, park("cloneDecay", 20), 50, 50],
  },
  // Iterations of a shifted copy differenced against the running result, so the
  // shifted partials cancel and comb the spectrum. Macro 1 sets the shift, Macro 2 leans it.
  {
    id: "interference",
    name: "Interference",
    color: { hue: "indigo", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "interference-step-1",
        name: "Step 1",
        effects: [
          {
            id: "interference-transform",
            effect: "transform",
            enabled: true,
            params: {
              transformShiftSemis: 7,
              transformShiftSemisModMacro1Amount: 100,
              transformRotation: 0,
              transformRotationModMacro2Amount: 100,
              transformEdgeMode: 1,
            },
          },
        ],
        brushIntensity: 100,
        brushIntensityModMacro3Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
        brushIterations: 6,
        blendMode: 7,
      },
    ],
    linkedParams: [],
    macroNames: ["Shift", "Turn", "Mix", "Macro 4"],
    macroValues: [park("transformShiftSemis", 7), park("transformRotation", 0), park("brushIntensity", 100), 50],
  },
  // Wrap edges send whatever the shift pushes past the top back in at the bottom, so
  // stacked passes climb forever. Macro 1 is the step: below centre it falls instead.
  {
    id: "barberpole",
    name: "Barberpole",
    color: { hue: "grape", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "barberpole-step-1",
        name: "Step 1",
        effects: [
          {
            id: "barberpole-transform",
            effect: "transform",
            enabled: true,
            params: { transformShiftSemis: 3, transformShiftSemisModMacro1Amount: 100, transformEdgeMode: 2 },
          },
          {
            id: "barberpole-blur",
            effect: "blur",
            enabled: true,
            params: {
              blurAmountTime: 0,
              blurAmountPitch: 10,
              blurAmountPitchModMacro3Amount: 100,
              blurSamplesY: 16,
            },
          },
        ],
        brushIntensity: 50,
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
        brushIterations: 8,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Rise", "Blend", "Fuse", "Macro 4"],
    macroValues: [park("transformShiftSemis", 3), park("brushIntensity", 50), 10, 50],
  },
  // A stepped cell field detunes and pans each cell on its own, breaking the region
  // into shards. Macro 1 scales the shattering, Macro 2 hangs a halo behind it.
  {
    id: "crystallise",
    name: "Crystallise",
    color: { hue: "cyan", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "crystallise-step-1",
        name: "Step 1",
        effects: [
          {
            id: "crystallise-transform",
            effect: "transform",
            enabled: true,
            params: { transformShiftSemis: 0, transformShiftSemisMod1Amount: 5, transformEdgeMode: 1 },
          },
          {
            id: "crystallise-binaural",
            effect: "binaural",
            enabled: true,
            params: {
              binauralAzimuth: 0,
              binauralAzimuthMod1Amount: 60,
              binauralDistance: 1,
              binauralStereoAngle: 180,
              binauralStereoAngleModMacro3Amount: 100,
            },
          },
          {
            id: "crystallise-blur",
            effect: "blur",
            enabled: true,
            params: {
              blurAmountTime: 0,
              blurAmountTimeModMacro2Amount: 100,
              blurSamplesX: 32,
              blurOrigin: 0,
            },
          },
        ],
        modulator1Mode: 0,
        modulator1PatternShape: 15,
        modulator1PatternRateBeats: 0.25,
        modulator1PatternRateSemis: 6,
        modulator1StrengthModMacro1Amount: 100,
        brushIntensityModMacro4Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Shatter", "Halo", "Width", "Mix"],
    macroValues: [park("modulator1Strength", 100), 15, park("binauralStereoAngle", 180), park("brushIntensity", 100)],
  },
  // Four steps in one stroke: a gate and a pull onto the scale, a stack of scale voices,
  // a long tail, then a slow drift around the listener. One macro per step.
  {
    id: "cathedral",
    name: "Cathedral",
    color: { hue: "teal", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "cathedral-step-1",
        name: "Purify",
        effects: [
          {
            id: "cathedral-dynamics",
            effect: "dynamics",
            enabled: true,
            params: { dynamicsThresholdDb: -50, dynamicsLowerRatio: 0, dynamicsKnee: 6 },
          },
          {
            id: "cathedral-attract",
            effect: "attract",
            enabled: true,
            params: {
              attractMap: 1,
              attractAmountX: 0,
              attractAmountY: 100,
              attractAmountYModMacro1Amount: 100,
              attractSmoothY: 1,
            },
          },
        ],
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
      {
        id: "cathedral-step-2",
        name: "Choir",
        effects: [
          {
            id: "cathedral-clone",
            effect: "clone",
            enabled: true,
            params: {
              cloneCountX: 0,
              cloneCountY: 3,
              cloneSpaceBeats: 0,
              cloneSpaceSemis: 4,
              cloneShapeY: "scale",
              cloneDirectionY: 0,
              cloneDecay: 40,
              cloneDecayModMacro2Amount: 100,
            },
          },
        ],
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
      {
        id: "cathedral-step-3",
        name: "Nave",
        effects: [
          {
            id: "cathedral-blur",
            effect: "blur",
            enabled: true,
            params: {
              blurAmountTime: 40,
              blurAmountTimeModMacro3Amount: 100,
              blurAmountPitch: 0,
              blurSamplesX: 48,
              blurOrigin: 0,
            },
          },
        ],
        brushSizeTime: 6,
        brushSizePitch: 128,
        brushCurveTime: -40,
        brushCurvePitch: 100,
        brushSkewTime: -100,
        brushAnchorMode: 0,
        brushIterations: 2,
        brushIntensity: 70,
        blendMode: 1,
      },
      {
        id: "cathedral-step-4",
        name: "Vault",
        effects: [
          {
            id: "cathedral-binaural",
            effect: "binaural",
            enabled: true,
            params: {
              binauralAzimuth: 0,
              binauralAzimuthMod1Amount: 30,
              binauralDistance: 3,
              binauralDistanceModMacro4Amount: 100,
              binauralStereoAngle: 180,
            },
          },
        ],
        modulator1Mode: 0,
        modulator1PatternShape: 0,
        modulator1PatternRateBeats: 8,
        brushSizeTime: 6,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Tune", "Voices", "Tail", "Distance"],
    macroValues: [park("attractAmountY", 100), park("cloneDecay", 40), 40, park("binauralDistance", 3)],
  },

  // --- Macros ---
  // Macro 1 opens a blur, Macro 2 sets how fast the echoes fade: two knobs morph the whole brush.
  {
    id: "morph",
    name: "Morph",
    color: { hue: "orange", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "morph-step-1",
        name: "Step 1",
        effects: [
          {
            id: "morph-blur",
            effect: "blur",
            enabled: true,
            params: { blurAmountTime: 0, blurSamplesX: 32, blurAmountTimeModMacro1Amount: 100 },
          },
          {
            id: "morph-clone",
            effect: "clone",
            enabled: true,
            params: { cloneSpaceBeats: 0.5, cloneCountX: 3, cloneDecay: 50, cloneDecayModMacro2Amount: 100 },
          },
        ],
        brushSizeTime: 3,
        brushSizePitch: 96,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Blur", "Echo Fade", "Macro 3", "Macro 4"],
    macroValues: [0, park("cloneDecay", 50), 50, 50],
  },

  // --- Source / sample painting ---
  // Reads the file itself at a fixed offset from the stroke, so a slice picked once
  // paints anywhere else in the same file. Hard time edges keep the slice from bleeding.
  // Macro 1 scrubs the read point through the file, Macro 2 moves it in pitch.
  {
    id: "stamp",
    name: "Stamp",
    color: { hue: "pink", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "stamp-step-1",
        name: "Step 1",
        effects: [],
        sourceFile: null,
        sourcePositionMode: "anchored",
        sourceTimeOffsetModMacro1Amount: 100,
        sourcePitchOffsetModMacro2Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Slide", "Pitch", "Macro 3", "Macro 4"],
    macroValues: [50, 50, 50, 50],
  },
  // Paints the spectrum of a bundled pad sample wherever you brush. Macro 1 sets the level.
  {
    id: "sampler",
    name: "Sampler",
    color: { hue: "pink", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "sampler-step-1",
        name: "Step 1",
        effects: [],
        sourceFile: { path: "bundled://pad-loop.mp3" },
        sourcePositionMode: "follow",
        brushIntensityModMacro1Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 96,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Level", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [park("brushIntensity", 100), 50, 50, 50],
  },
  // Reads a bundled break at a read point re-drawn every quarter beat, so a drag deals
  // the sample back out in a new order. Point Source at any open file to shuffle that instead.
  // Macro 1 moves the read point in pitch, Macro 2 sets how far it jumps.
  {
    id: "shuffler",
    name: "Shuffler",
    color: { hue: "green", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "shuffler-step-1",
        name: "Step 1",
        effects: [],
        sourceFile: { path: "bundled://break-loop.mp3" },
        sourcePositionMode: "fixed",
        sourceTimeOffsetMod1Amount: 100,
        sourcePitchOffsetModMacro1Amount: 100,
        modulator1Mode: 0,
        modulator1PatternShape: 5,
        modulator1PatternRateBeats: 0.25,
        modulator1PatternRateSemis: 0,
        modulator1StrengthModMacro2Amount: 100,
        brushIntensityModMacro3Amount: 100,
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Pitch", "Chop", "Mix", "Macro 4"],
    macroValues: [50, park("modulator1Strength", 100), park("brushIntensity", 100), 50],
  },

  // --- Convolution ---
  // Convolves painted material with a bundled reverb impulse response for a smeared tail.
  // Macro 1 sets how much of the IR is read, Macro 2 the wet level, Macro 3 where it starts,
  // Macro 4 its tuning.
  {
    id: "convolution",
    name: "Convolution",
    color: { hue: "teal", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "convolution-step-1",
        name: "Step 1",
        effects: [
          {
            id: "convolution-convolve",
            effect: "convolve",
            enabled: true,
            params: {
              convolveIrFile: { path: "bundled://reverb-ir.mp3" },
              convolveIrSize: 96,
              convolveIrSizeModMacro1Amount: 100,
              convolveIrTimeOffset: 0,
              convolveIrTimeOffsetModMacro3Amount: 100,
              convolveIrPitchShift: 0,
              convolveIrPitchShiftModMacro4Amount: 100,
              convolveGainDb: 0,
              convolveIrRate: 1,
            },
          },
        ],
        brushSizeTime: 6,
        brushSizePitch: 128,
        brushCurveTime: -40,
        brushSkewTime: -100,
        brushAnchorMode: 0,
        brushIntensity: 80,
        brushIntensityModMacro2Amount: 100,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Tail", "Mix", "Start", "Tune"],
    macroValues: [
      park("convolveIrSize", 96),
      park("brushIntensity", 80),
      park("convolveIrTimeOffset", 0),
      park("convolveIrPitchShift", 0),
    ],
  },

  // --- Breaks ---
  // Old-sampler timestretch: the region is stretched to double length with the Flangey warp,
  // while a 16th-of-a-beat sequencer ripples the level for the classic cyclic flutter.
  // Macro 1 is a varispeed stretch, Macro 2 warps the harmonic spread like a formant,
  // Macro 3 opens a smear over the top, Macro 4 sets how hard the flutter cuts.
  {
    id: "time-stretch",
    name: "Time Stretch",
    color: { hue: "orange", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "time-stretch-step-1",
        name: "Step 1",
        effects: [
          {
            id: "time-stretch-transform",
            effect: "transform",
            enabled: true,
            params: {
              transformScaleTime: 2,
              transformScaleTimeModMacro1Amount: 100,
              transformScalePitch: 1,
              transformScalePitchModMacro2Amount: 100,
              transformEdgeMode: 0,
            },
          },
          {
            id: "time-stretch-dynamics",
            effect: "dynamics",
            enabled: true,
            params: { dynamicsGainDb: 0, dynamicsGainDbMod1Amount: 100 },
          },
          {
            id: "time-stretch-blur",
            effect: "blur",
            enabled: true,
            params: { blurAmountTime: 0, blurAmountTimeModMacro3Amount: 100, blurSamplesX: 32, blurOrigin: 1 },
          },
        ],
        algorithm: 0,
        modulator1Mode: 2,
        modulator1SeqStepsX: 16,
        modulator1SeqStepsY: 1,
        modulator1SeqLoopBeats: 1,
        modulator1StrengthModMacro4Amount: 100,
        // Cells alternate about 0 dB and about -23 dB through the gain range, giving the flutter.
        modulator1SeqData: JSON.stringify({
          values: [[0.77, 0.55, 0.77, 0.55, 0.77, 0.55, 0.77, 0.55, 0.77, 0.55, 0.77, 0.55, 0.77, 0.55, 0.77, 0.55]],
        }),
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Stretch", "Formant", "Smear", "Flutter"],
    macroValues: [park("transformScaleTime", 2), park("transformScalePitch", 1), 0, park("modulator1Strength", 100)],
  },
  // A long stretch under the Noisey warp, which scrambles the phase into a smooth wash
  // rather than a stutter. Macro 1 is the stretch, Macro 2 smears what is left of the grain.
  {
    id: "paul-stretch",
    name: "Paul Stretch",
    color: { hue: "cyan", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "paul-stretch-step-1",
        name: "Step 1",
        effects: [
          {
            id: "paul-stretch-transform",
            effect: "transform",
            enabled: true,
            params: {
              transformScaleTime: 8,
              transformScaleTimeModMacro1Amount: 100,
              transformOriginTime: 0,
              transformEdgeMode: 0,
            },
          },
          {
            id: "paul-stretch-blur",
            effect: "blur",
            enabled: true,
            params: { blurAmountTime: 0, blurAmountTimeModMacro2Amount: 100, blurSamplesX: 48, blurOrigin: 1 },
          },
        ],
        algorithm: 1,
        brushIntensityModMacro3Amount: 100,
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Stretch", "Smear", "Mix", "Macro 4"],
    macroValues: [park("transformScaleTime", 8), 20, park("brushIntensity", 100), 50],
  },
  // Repeats the slice under the brush forward at every quarter beat: a retrigger fill.
  // Macro 1 fades the repeats out, Macro 2 blends the fill against what is there,
  // Macro 3 spaces the repeats.
  {
    id: "stutter",
    name: "Stutter",
    color: { hue: "grape", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "stutter-step-1",
        name: "Step 1",
        effects: [
          {
            id: "stutter-clone",
            effect: "clone",
            enabled: true,
            params: {
              cloneSpaceBeats: 0.25,
              cloneSpaceBeatsModMacro3Amount: 100,
              cloneCountX: 7,
              cloneCountY: 0,
              cloneDecay: 0,
              cloneDecayModMacro1Amount: 100,
              cloneDirectionX: 0,
              cloneEdgeMode: 1,
            },
          },
        ],
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 0.25,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Fade", "Blend", "Rate", "Macro 4"],
    macroValues: [park("cloneDecay", 0), park("brushIntensity", 100), park("cloneSpaceBeats", 0.25), 50],
  },
  // Plays the region backwards under decaying pre-echoes and a backwards smear: a spin-back.
  // Macro 1 is the platter speed, Macro 2 lengthens the smear.
  {
    id: "rewind",
    name: "Rewind",
    color: { hue: "red", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "rewind-step-1",
        name: "Step 1",
        effects: [
          {
            id: "rewind-transform",
            effect: "transform",
            enabled: true,
            params: { transformScaleTime: -1, transformScaleTimeModMacro1Amount: 100, transformEdgeMode: 0 },
          },
          {
            id: "rewind-clone",
            effect: "clone",
            enabled: true,
            params: {
              cloneSpaceBeats: 0.5,
              cloneCountX: 2,
              cloneCountY: 0,
              cloneDecay: 40,
              cloneDirectionX: 2,
              cloneEdgeMode: 1,
            },
          },
          {
            id: "rewind-blur",
            effect: "blur",
            enabled: true,
            params: { blurAmountTime: 30, blurAmountTimeModMacro2Amount: 100, blurSamplesX: 24, blurOrigin: 2 },
          },
        ],
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Spin", "Trail", "Macro 3", "Macro 4"],
    macroValues: [park("transformScaleTime", -1), 25, 50, 50],
  },

  // --- Waveshape ---
  // Folds the spectrum through a wavefolder, turning clean material metallic and buzzy.
  // Macro 1 pushes the fold harder, Macro 2 leans it across the phase axes.
  {
    id: "crush",
    name: "Crush",
    color: { hue: "violet", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "crush-step-1",
        name: "Step 1",
        effects: [
          {
            id: "crush-waveshape",
            effect: "waveshape",
            enabled: true,
            params: {
              waveshapeMode: 3,
              waveshapeDrive: 4,
              waveshapeDriveModMacro1Amount: 100,
              waveshapeTilt: 0,
              waveshapeTiltModMacro2Amount: 100,
            },
          },
        ],
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Drive", "Tilt", "Macro 3", "Macro 4"],
    macroValues: [park("waveshapeDrive", 4), park("waveshapeTilt", 0), 50, 50],
  },

  // --- Attract ---
  // Pulls painted energy onto the notes of the selected scale, retuning smeared material.
  // Macro 1 runs from repel through off to full pull, Macro 2 widens the valleys it falls into.
  {
    id: "magnet",
    name: "Magnet",
    color: { hue: "yellow", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "magnet-step-1",
        name: "Step 1",
        effects: [
          {
            id: "magnet-attract",
            effect: "attract",
            enabled: true,
            params: {
              attractMap: 1,
              attractAmountX: 0,
              attractAmountY: 100,
              attractAmountYModMacro1Amount: 100,
              attractSmoothY: 2,
              attractSmoothYModMacro2Amount: 100,
            },
          },
        ],
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Pull", "Reach", "Macro 3", "Macro 4"],
    macroValues: [park("attractAmountY", 100), park("attractSmoothY", 2), 50, 50],
  },

  // --- Blur (freeze) ---
  // Smears the region both ways in time and keeps only the louder result, so peaks hang as a held wash.
  // Macro 1 blooms the wash vertically, Macro 2 blends it in.
  {
    id: "freeze",
    name: "Freeze",
    color: { hue: "cyan", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "freeze-step-1",
        name: "Step 1",
        effects: [
          {
            id: "freeze-blur",
            effect: "blur",
            enabled: true,
            params: {
              blurAmountTime: 100,
              blurAmountPitch: 0,
              blurAmountPitchModMacro1Amount: 100,
              blurSamplesX: 64,
              blurOrigin: 1,
            },
          },
        ],
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 60,
        brushCurvePitch: 60,
        brushAnchorMode: 1,
        brushIterations: 4,
        blendMode: 5,
      },
    ],
    linkedParams: [],
    macroNames: ["Glow", "Mix", "Macro 3", "Macro 4"],
    macroValues: [0, park("brushIntensity", 100), 50, 50],
  },

  // --- Evolve (updraft) ---
  // Biases the evolve simulation upwards over many iterations, so energy rises off the sound like smoke.
  // Macro 1 sets the climb, Macro 2 curls it into turbulence.
  {
    id: "updraft",
    name: "Updraft",
    color: { hue: "green", variation: 0 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "updraft-step-1",
        name: "Step 1",
        effects: [
          {
            id: "updraft-evolve",
            effect: "evolve",
            enabled: true,
            params: {
              evolveFlow: 30,
              evolveSpread: 20,
              evolveSwirl: 0,
              evolveSwirlModMacro2Amount: 100,
              evolveDriftY: 60,
              evolveDriftYModMacro1Amount: 100,
              evolveScaleX: 40,
              evolveScaleY: 40,
            },
          },
        ],
        accumulate: true,
        brushSizeTime: 3,
        brushSizePitch: 96,
        brushCurveTime: 60,
        brushCurvePitch: 60,
        brushAnchorMode: 1,
        brushIterations: 10,
      },
    ],
    linkedParams: [],
    macroNames: ["Lift", "Chaos", "Macro 3", "Macro 4"],
    macroValues: [park("evolveDriftY", 60), park("evolveSwirl", 0), 50, 50],
  },

  // --- Synthesize (crackle) ---
  // Paints impulses gated by a fast random pattern, then a noise gate thins the quiet ones:
  // vinyl crackle and dust. Macro 1 raises the gate to thin the crackle, Macro 2 sets its level.
  {
    id: "crackle",
    name: "Crackle",
    color: { hue: "green", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "crackle-step-1",
        name: "Step 1",
        effects: [
          {
            id: "crackle-synth",
            effect: "synthesize",
            enabled: true,
            params: { synthesizeBrushType: 2 },
          },
          {
            id: "crackle-dynamics",
            effect: "dynamics",
            enabled: true,
            params: {
              dynamicsThresholdDb: -40,
              dynamicsThresholdDbModMacro1Amount: 100,
              dynamicsLowerRatio: 0,
              dynamicsKnee: 3,
              dynamicsGainDb: -12,
              dynamicsGainDbModMacro2Amount: 100,
            },
          },
        ],
        brushIntensityMod1Amount: 100,
        modulator1Mode: 0,
        modulator1PatternShape: 5,
        modulator1PatternRateBeats: 0.0625,
        modulator1PatternRateSemis: 0,
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Sparse", "Level", "Macro 3", "Macro 4"],
    macroValues: [park("dynamicsThresholdDb", -40), park("dynamicsGainDb", -12), 50, 50],
  },

  // --- Clone (chord stack) ---
  // Stacks copies of the painted note up the selected scale into an instant chord.
  // Macro 1 fades the upper voices, Macro 2 blends the stack in.
  {
    id: "stack",
    name: "Stack",
    color: { hue: "indigo", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "stack-step-1",
        name: "Step 1",
        effects: [
          {
            id: "stack-clone",
            effect: "clone",
            enabled: true,
            params: {
              cloneCountX: 0,
              cloneCountY: 3,
              cloneSpaceBeats: 0,
              cloneSpaceSemis: 3,
              cloneShapeY: "scale",
              cloneDirectionY: 0,
              cloneDecay: 35,
              cloneDecayModMacro1Amount: 100,
            },
          },
        ],
        brushIntensityModMacro2Amount: 100,
        brushSizeTime: 2,
        brushSizePitch: 12,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Fade", "Blend", "Macro 3", "Macro 4"],
    macroValues: [park("cloneDecay", 35), park("brushIntensity", 100), 50, 50],
  },
];
