import { CURRENT_PRESET_VERSION, PresetType } from "./preset-schema";

const DEFAULT_MACRO_NAMES = ["Macro 1", "Macro 2", "Macro 3", "Macro 4"];
const DEFAULT_MACRO_VALUES = [50, 50, 50, 50];

export const factoryPresets: PresetType[] = [
  {
    id: "init",
    name: "Init",
    description: "An empty brush with no effects. The blank slate to build your own from.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "init-step-1",
        name: "Step 1",
        effects: [],
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  {
    id: "eraser",
    name: "Eraser",
    description: "Silences whatever you paint over by dropping its gain to nothing.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "eraser-step-1",
        name: "Step 1",
        effects: [{ id: "eraser-dynamics", effect: "dynamics", enabled: true, params: { dynamicsGainDb: -80 } }],
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  {
    id: "booster",
    name: "Booster",
    description: "Lifts the level of the region you paint over.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "booster-step-1",
        name: "Step 1",
        effects: [{ id: "booster-dynamics", effect: "dynamics", enabled: true, params: { dynamicsGainDb: 6 } }],
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  {
    id: "restore",
    name: "Restore",
    description: "Paints the file's original, unedited audio back over your edits.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "restore-step-1",
        name: "Step 1",
        effects: [],
        sourceDataMode: "original",
        blendMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  {
    id: "stereo-widening",
    name: "Stereo Widening",
    description: "Spreads the painted region wider across the stereo field.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "stereo-widening-step-1",
        name: "Step 1",
        effects: [],
        brushPanMod1Amount: 100,
        modulator1PatternRateBeats: 4,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Dynamics ---
  // Tames loud regions: gentle compression above threshold with makeup gain. Broadband, full-height brush.
  {
    id: "compressor",
    name: "Compressor",
    description: "Tames loud regions with gentle compression and makeup gain, across the full pitch range.",
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
            params: { dynamicsThresholdDb: -24, dynamicsUpperRatio: 0.4, dynamicsKnee: 12, dynamicsGainDb: 3 },
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
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  // Silences anything below the threshold to clean up hiss and bleed between sounds.
  {
    id: "noise-gate",
    name: "Noise Gate",
    description: "Silences anything below the threshold to clean up hiss and bleed between sounds.",
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
            params: { dynamicsThresholdDb: -45, dynamicsLowerRatio: 0, dynamicsKnee: 6 },
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
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  // Accumulate makes overlapping dabs re-blur the already-blurred result, so dragging smears content around.
  {
    id: "smudge",
    name: "Smudge",
    description: "Drag to smear content around — each dab re-blurs what the last one left behind.",
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
            params: { blurAmountTime: 50, blurAmountPitch: 50, blurSamplesX: 12, blurSamplesY: 12 },
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
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Transform ---
  // Shifts content up one octave within the brush.
  {
    id: "octave-up",
    name: "Octave Up",
    description: "Shifts whatever you paint over up by one octave.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "octave-up-step-1",
        name: "Step 1",
        effects: [
          { id: "octave-up-transform", effect: "transform", enabled: true, params: { transformShiftSemis: 12 } },
        ],
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  // Shifts content down one octave within the brush.
  {
    id: "octave-down",
    name: "Octave Down",
    description: "Shifts whatever you paint over down by one octave.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "octave-down-step-1",
        name: "Step 1",
        effects: [
          { id: "octave-down-transform", effect: "transform", enabled: true, params: { transformShiftSemis: -12 } },
        ],
        brushSizeTime: 2,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  // Mirrors the painted window in time. Cut edges keep neighbouring audio out of the reversed chunk.
  {
    id: "reverse",
    name: "Reverse",
    description: "Plays the painted window backwards, leaving the audio around it untouched.",
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
            params: { transformScaleTime: -1, transformEdgeMode: 0 },
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
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Classic filters ---
  // Dynamics cut weighted toward the top of the spectrum (a low-pass tilt), with the emphasis swept by a sine LFO.
  {
    id: "low-pass-sweep",
    name: "Low-Pass Sweep",
    description: "A low-pass tilt whose corner is swept up and down by an LFO.",
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
        modulator1Mode: 0,
        modulator1PatternShape: 0,
        modulator1PatternRateBeats: 4,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  // Dynamics cut weighted toward the bottom of the spectrum: a static high-pass / low-cut.
  {
    id: "high-pass",
    name: "High-Pass",
    description: "A static low-cut that thins out the bottom of the painted region.",
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
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Overtones ---
  // Stacks decaying octave overtones on top of the painted material to thicken a tone.
  {
    id: "harmonics",
    name: "Harmonics",
    description: "Stacks decaying octave overtones on the painted material to thicken a tone.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "harmonics-step-1",
        name: "Step 1",
        effects: [
          {
            id: "harmonics-overtones",
            effect: "overtones",
            enabled: true,
            params: { overtonesCount: 16, overtonesShape: "octaves", overtonesDecay: 60, overtonesScale: 1 },
          },
        ],
        brushSizeTime: 2,
        brushSizePitch: 24,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Blur ---
  // Smears energy forward in time (origin Left) into a reverb-like tail. Add blend layers the tail over the dry sound.
  {
    id: "reverb",
    name: "Reverb (Blur)",
    description: "Smears energy forward in time into a reverb-like tail, layered over the dry sound.",
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
            params: { blurAmountTime: 100, blurAmountPitch: 0, blurSamplesX: 48, blurOrigin: 0 },
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
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Clone ---
  // Beat-spaced decaying copies extending forward in time: a rhythmic delay.
  {
    id: "echo",
    name: "Echo",
    description: "Beat-spaced decaying copies extending forward in time — a rhythmic delay.",
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
            params: { cloneSpaceBeats: 0.5, cloneCountX: 5, cloneCountY: 1, cloneDecay: 55, cloneDirectionX: 0 },
          },
        ],
        brushSizeTime: 4,
        brushSizePitch: 48,
        brushCurveTime: -50,
        brushSkewTime: -100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Synthesize ---
  // Draws broadband noise with a soft, rounded 2D envelope for air and texture.
  {
    id: "paint-noise",
    name: "Paint Noise",
    description: "Draws broadband noise with a soft, rounded edge. Good for air and texture.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "paint-noise-step-1",
        name: "Step 1",
        effects: [{ id: "paint-noise-synth", effect: "synthesize", enabled: true, params: { synthesizeBrushType: 0 } }],
        brushSizeTime: 2,
        brushSizePitch: 36,
        brushCurveTime: -60,
        brushCurvePitch: -60,
        brushSkewTime: 0,
        brushSkewPitch: 0,
        brushAnchorMode: 1,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  // Draws a single-semitone sine note with a sharp attack and long release.
  {
    id: "paint-tone",
    name: "Paint Tone",
    description: "Draws a single sine note with a sharp attack and a long release.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "paint-tone-step-1",
        name: "Step 1",
        effects: [{ id: "paint-tone-synth", effect: "synthesize", enabled: true, params: { synthesizeBrushType: 1 } }],
        brushSizeTime: 2,
        brushSizePitch: 1,
        brushCurveTime: -40,
        brushCurvePitch: 100,
        brushSkewTime: -100,
        brushSkewPitch: 0,
        brushAnchorMode: 0,
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Evolve ---
  // Reaction-advection-diffusion run over several iterations for a flowing, smoke-like smear.
  {
    id: "flow",
    name: "Flow",
    description: "Smears the painted region into flowing, smoke-like shapes over several iterations.",
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
            params: { evolveFlow: 40, evolveSpread: 30, evolveSwirl: 20, evolveScaleX: 50, evolveScaleY: 50 },
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
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Sort ---
  // Many iterations of magnitude sorting smear bins into vertical streaks for a glitch aesthetic.
  {
    id: "pixel-sort",
    name: "Pixel Sort",
    description: "Sorts spectral bins into vertical streaks for a glitchy, smeared look and sound.",
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
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Modulation showcases ---
  // Pattern modulator (sine LFO) dips dynamics gain rhythmically for a tremolo.
  {
    id: "tremolo",
    name: "Tremolo",
    description: "An LFO dips the gain rhythmically across the painted region.",
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
            params: { dynamicsGainDb: 0, dynamicsGainDbMod1Amount: -50 },
          },
        ],
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
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  // Step-sequencer modulator gates dynamics gain into a rhythmic pattern.
  {
    id: "step-gate",
    name: "Step Gate",
    description: "A step sequencer chops the painted region into a rhythmic gate pattern.",
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
            params: { dynamicsGainDb: 0, dynamicsGainDbMod1Amount: -100 },
          },
        ],
        modulator1Mode: 2,
        modulator1SeqStepsX: 8,
        modulator1SeqStepsY: 1,
        modulator1SeqLoopBeats: 2,
        modulator1SeqData: JSON.stringify({ values: [[1, 0, 1, 1, 0, 1, 1, 0]] }),
        brushSizeTime: 4,
        brushSizePitch: 128,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 0,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  // Envelope-follower modulator tracks amplitude and opens a blur on the loudest material.
  {
    id: "dynamic-bloom",
    name: "Dynamic Bloom",
    description: "Follows the amplitude of what you paint over and blurs the loudest material most.",
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
        brushSizeTime: 3,
        brushSizePitch: 96,
        brushCurveTime: 60,
        brushCurvePitch: 60,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
  // Binaural azimuth swept by a sine LFO so the source orbits the listener.
  {
    id: "3d-orbit",
    name: "3D Orbit",
    description: "Sweeps the painted region around the listener in 3D using binaural panning.",
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
            params: { binauralAzimuth: 0, binauralDistance: 2, binauralAzimuthMod1Amount: 100 },
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
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Effect chaining ---
  // Octave-up clone feeding a forward blur, repeated, builds a rising shimmer tail.
  {
    id: "shimmer",
    name: "Shimmer",
    description: "Octave-up copies feeding a forward blur, repeated into a rising shimmer tail.",
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
            params: { cloneSpaceSemis: 12, cloneCountX: 1, cloneCountY: 2, cloneDirectionY: 0, cloneDecay: 50 },
          },
          {
            id: "shimmer-blur",
            effect: "blur",
            enabled: true,
            params: { blurAmountTime: 80, blurSamplesX: 40, blurOrigin: 0 },
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
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Macros ---
  // Macro 1 opens a blur, Macro 2 sets echo feedback: two knobs morph the whole brush.
  {
    id: "morph",
    name: "Morph (Macros)",
    description: "Two macro knobs — Blur and Echo Tail — reshape the whole brush as you turn them.",
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
            params: { cloneSpaceBeats: 0.5, cloneCountX: 4, cloneDecay: 50, cloneDecayModMacro2Amount: -50 },
          },
        ],
        brushSizeTime: 3,
        brushSizePitch: 96,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: ["Blur", "Echo Tail", "Macro 3", "Macro 4"],
    macroValues: [0, 50, 50, 50],
  },

  // --- Source / sample painting ---
  // Paints the spectrum of a bundled pad sample wherever you brush.
  {
    id: "sampler",
    name: "Sampler",
    description: "Paints the spectrum of a bundled pad sample wherever you brush.",
    isFactory: true,
    version: CURRENT_PRESET_VERSION,
    steps: [
      {
        id: "sampler-step-1",
        name: "Step 1",
        effects: [],
        sourceFile: { path: "bundled://pad-loop.mp3" },
        sourcePositionMode: "follow",
        brushSizeTime: 2,
        brushSizePitch: 96,
        brushCurveTime: 100,
        brushCurvePitch: 100,
        brushAnchorMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },

  // --- Convolution ---
  // Convolves painted material with a bundled reverb impulse response for a smeared tail.
  {
    id: "convolution",
    name: "Convolution",
    description: "Convolves what you paint with a bundled reverb impulse response for a smeared tail.",
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
        blendMode: 1,
      },
    ],
    linkedParams: [],
    macroNames: DEFAULT_MACRO_NAMES,
    macroValues: DEFAULT_MACRO_VALUES,
  },
];
