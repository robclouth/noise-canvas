import { CURRENT_PRESET_VERSION, PresetType } from "./preset-schema";

// A `<param>ModMacroNAmount` of 100 makes the macro knob sweep that parameter
// along its slider, replacing the base value, so each preset's macroValues place
// the parameter at the sound the preset ships with. A negative amount runs the
// sweep the other way.

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
    macroValues: [0, 50, 50, 50],
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
    macroValues: [83, 50, 50, 50],
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
    macroValues: [100, 50, 50, 50],
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
    macroValues: [100, 50, 50, 50],
  },

  // --- Dynamics ---
  // Tames loud regions: gentle compression above threshold with makeup gain. Broadband, full-height brush.
  // Macro 1 blends the compressed signal in parallel; Macro 2 moves the threshold.
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
    macroNames: ["Amount", "Threshold", "Macro 3", "Macro 4"],
    macroValues: [100, 60, 50, 50],
  },
  // Silences anything below the threshold to clean up hiss and bleed between sounds.
  // Macro 1 raises the threshold to gate harder.
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
    macroNames: ["Threshold", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [25, 50, 50, 50],
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
    macroValues: [50, 50, 50, 50],
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
    macroValues: [100, 50, 50, 50],
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
    macroValues: [100, 50, 50, 50],
  },
  // Mirrors the painted window in time. Cut edges keep neighbouring audio out of the reversed chunk.
  // Macro 1 is a varispeed knob: −4× through freeze to +4×, parked at −1×.
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
    macroValues: [37.5, 100, 50, 50],
  },

  // --- Classic filters ---
  // Dynamics cut weighted toward the top of the spectrum (a low-pass tilt), with the emphasis swept by a sine LFO.
  // Macro 1 moves the tilt point like a cutoff.
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
          { id: "low-pass-sweep-dynamics", effect: "dynamics", enabled: true, params: { dynamicsGainDb: -40 } },
        ],
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: -40,
        brushSkewPitch: 70,
        brushSkewPitchMod1Amount: 30,
        brushSkewPitchModMacro1Amount: 100,
        modulator1Mode: 0,
        modulator1PatternShape: 0,
        modulator1PatternRateBeats: 4,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Cutoff", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [85, 50, 50, 50],
  },
  // Dynamics cut weighted toward the bottom of the spectrum: a static high-pass / low-cut.
  // Macro 1 leans the cut from the lows to the highs, morphing it toward a low-pass.
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
        effects: [{ id: "high-pass-dynamics", effect: "dynamics", enabled: true, params: { dynamicsGainDb: -40 } }],
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
    macroNames: ["Tilt", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [0, 50, 50, 50],
  },

  // --- Harmonics ---
  // Stacks a decaying harmonic series on top of the painted material to thicken a tone.
  // Macro 1 fades the upper partials, Macro 2 blends the stack in.
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
    macroNames: ["Fade", "Blend", "Macro 3", "Macro 4"],
    macroValues: [60, 100, 50, 50],
  },

  // --- Blur ---
  // Smears energy forward in time (origin Left) into a reverb-like tail. Add blend layers the tail over the dry sound.
  // Macro 1 sets the tail length, Macro 2 the wet level.
  {
    id: "reverb",
    name: "Reverb (Blur)",
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
    macroNames: ["Size", "Mix", "Macro 3", "Macro 4"],
    macroValues: [100, 80, 50, 50],
  },

  // --- Clone ---
  // Beat-spaced decaying copies extending forward in time: a rhythmic delay.
  // Macro 1 fades the repeats, Macro 2 blends them in.
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
    macroNames: ["Fade", "Blend", "Macro 3", "Macro 4"],
    macroValues: [55, 100, 50, 50],
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
        brushCurveTimeModMacro2Amount: 50,
        brushCurvePitch: -60,
        brushCurvePitchModMacro2Amount: 50,
        brushSkewTime: 0,
        brushSkewPitch: 0,
        brushAnchorMode: 1,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Level", "Edge", "Macro 3", "Macro 4"],
    macroValues: [100, 20, 50, 50],
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
        brushCurveTimeModMacro2Amount: 50,
        brushCurvePitch: 100,
        brushSkewTime: -100,
        brushSkewPitch: 0,
        brushAnchorMode: 0,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Level", "Sustain", "Macro 3", "Macro 4"],
    macroValues: [100, 30, 50, 50],
  },

  // --- Evolve ---
  // Reaction-advection-diffusion run over several iterations for a flowing, smoke-like smear.
  // Macro 1 drives the current, Macro 2 curls it.
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
    macroValues: [70, 60, 50, 50],
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
    macroValues: [100, 50, 50, 50],
  },

  // --- Modulation showcases ---
  // A sine LFO fades a fixed dip in and out, so the level breathes without ever boosting.
  // Macro 1 sets the level the dips reach.
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
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Dip", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [54, 50, 50, 50],
  },
  // A step sequencer gates an erase in and out: sounding cells are the zeros, silent cells the ones.
  // Macro 1 sets the level the gated cells drop to.
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
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: ["Floor", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [0, 50, 50, 50],
  },
  // Envelope-follower modulator tracks amplitude and opens a blur on the loudest material.
  // Macro 1 scales how far the follower opens the blur.
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
        brushIntensityModMacro1Amount: 100,
        brushSizeTime: 3,
        brushSizePitch: 96,
        brushCurveTime: 60,
        brushCurvePitch: 60,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Amount", "Macro 2", "Macro 3", "Macro 4"],
    macroValues: [100, 50, 50, 50],
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
    macroValues: [19, 100, 50, 50],
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
    macroValues: [80, 50, 50, 50],
  },

  // --- Macros ---
  // Macro 1 opens a blur, Macro 2 sets how fast the echoes fade: two knobs morph the whole brush.
  {
    id: "morph",
    name: "Morph (Macros)",
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
            params: { cloneSpaceBeats: 0.5, cloneCountX: 3, cloneDecay: 50, cloneDecayModMacro2Amount: 50 },
          },
        ],
        brushSizeTime: 3,
        brushSizePitch: 96,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Blur", "Echo Fade", "Macro 3", "Macro 4"],
    macroValues: [0, 50, 50, 50],
  },

  // --- Source / sample painting ---
  // Reads the file itself at a fixed offset from the stroke, so a slice picked once
  // paints anywhere else in the same file. Hard time edges keep the slice from bleeding.
  // Macro 1 scrubs the read point through the file, Macro 2 nudges it in pitch.
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
        sourceTimeOffsetModMacro1Amount: 25,
        sourcePitchOffsetModMacro2Amount: 10,
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
    macroValues: [100, 50, 50, 50],
  },

  // --- Convolution ---
  // Convolves painted material with a bundled reverb impulse response for a smeared tail.
  // Macro 1 sets how much of the IR is read, Macro 2 the wet level.
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
    macroNames: ["Tail", "Mix", "Macro 3", "Macro 4"],
    macroValues: [19, 80, 50, 50],
  },

  // --- Breaks ---
  // Old-sampler timestretch: the region is stretched to double length with the Flangey warp,
  // while a 16th-of-a-beat sequencer ripples the level for the classic cyclic flutter.
  // Macro 1 is a varispeed stretch (reverse through freeze to 4×), Macro 2 warps the
  // harmonic spread like a formant, Macro 3 opens a smear over the top.
  {
    id: "jungle-stretch",
    name: "Jungle Stretch",
    color: { hue: "orange", variation: 1 },
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "jungle-stretch-step-1",
        name: "Step 1",
        effects: [
          {
            id: "jungle-stretch-transform",
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
            id: "jungle-stretch-dynamics",
            effect: "dynamics",
            enabled: true,
            params: { dynamicsGainDb: 0, dynamicsGainDbMod1Amount: 100 },
          },
          {
            id: "jungle-stretch-blur",
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
        // Cells alternate ≈0 dB and ≈−23 dB through the gain range, giving the flutter.
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
    macroNames: ["Stretch", "Formant", "Smear", "Macro 4"],
    macroValues: [75, 62.5, 0, 50],
  },
  // Repeats the slice under the brush forward at every quarter beat: a retrigger fill.
  // Macro 1 fades the repeats out, Macro 2 blends the fill against what is there.
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
    macroNames: ["Fade", "Blend", "Macro 3", "Macro 4"],
    macroValues: [0, 100, 50, 50],
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
    macroValues: [37.5, 30, 50, 50],
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
              waveshapeDrive: 1,
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
    macroValues: [6, 50, 50, 50],
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
    macroValues: [100, 8, 50, 50],
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
    macroValues: [0, 100, 50, 50],
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
    macroValues: [80, 50, 50, 50],
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
    macroValues: [33, 65, 50, 50],
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
    macroValues: [35, 100, 50, 50],
  },
];
