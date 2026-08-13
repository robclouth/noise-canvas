# Section Presets — Implementation Plan

> **Status: done.** The mechanism, the UI and the first 15 presets landed in
> `a2b6922`. Phases 1 to 4 below — the file-parameter rule, the sequencer keys
> and the remaining 53 presets — landed on `section-preset-content`. Kept as the
> record of what each preset is for and why the two defects existed.

Self-contained: parameter keys, ranges and option values are quoted here so no
prior conversation is needed.

**Changed on the way in.** Three things the plan got wrong, settled against the
code:

- **Bouncing Ball uses `harmonic`, not `geometric`.** The tables in
  `effects/clone-shapes.ts` are offsets, so `harmonic` (`log2(i+1)`) is the one
  whose gaps shrink. Note the axis labels read the other way round —
  `harmonic` shows as "Decelerating" and `geometric` as "Accelerating".
- **Swung Eighths needs hits on the offbeats.** Swing shifts odd steps, so a row
  of `1 0 1 0` is unaffected by it. The preset accents alternate steps instead:
  `1 .55 1 .55`.
- **Per Stroke is now Random Steps.** Brush phase mode reads the same patch of
  the field for every stroke, so it repeats rather than re-rolling. Canvas mode
  with the Random shape is the thing that actually gives a fresh value, one per
  beat and octave.

## Background

A section preset sets every parameter of one effect card or the modulator at
once. The pieces:

| File                                                    | Holds                                            |
| ------------------------------------------------------- | ------------------------------------------------ |
| `src/renderer/src/lib/section-presets.ts`               | Types, key mapping, resolve, capture, validation |
| `src/renderer/src/lib/factory-section-presets.ts`       | The shipped content                              |
| `src/renderer/src/store/section-presets.ts`             | Load, apply, save, duplicate, rename, delete     |
| `src/renderer/src/components/controls/section-menu.tsx` | The presets column in the ⋮                      |

Two rules the content depends on:

- **Applying is total.** `resolveSectionPreset` writes every key in the
  section's list — the ones the preset names, and every other one at its
  parameter default. A preset therefore fully describes its section, and
  applying two in a row gives the second rather than a mixture.
- **Modulator keys drop their index.** `toStorageId` strips `modulator\d+`, so
  a preset saved on modulator 1 loads onto any of the three. Effect keys are
  stored verbatim.

Colours are assigned by `pickSectionPresetColor`, walking the brush palette
within a scope, so no two presets in one list repeat. Factory colours are
computed at module load rather than written by hand.

Which keys a section owns comes from `EFFECT_PARAMS`
(`components/effects-list.tsx:44`) for effects and `getModulatorParamKeys`
(`components/modulator-view.tsx:152`) for the modulator. Presets, Reset and
Randomise all read the same list.

---

## Phase 1 — File parameters must survive

**Defect.** `EFFECT_PARAMS.convolve` includes `convolveIrFile`. Because
applying is total, a factory preset that names only the tail shape sets the IR
to its default of `null` — so picking "Hall" silently unloads the user's
impulse response.

**Rule.** A `kind: "file"` parameter is written only when the preset names it,
and left untouched when it does not.

- `resolveSectionPreset` skips a key whose def is `kind: "file"` unless the
  preset's `values` has that id.
- `captureSectionValues` keeps storing them, so a preset you save from a loaded
  IR carries its path.
- Applying a preset that names a file opens it, the way brush presets already
  do — `collectBrushReferencedPaths` and `openReferencedFiles` in
  `store/presets.ts:116`. Factor the open out so both callers share it.

Factory convolve presets name no IR and are therefore tail shapes that apply to
whatever is loaded. A preset you save from your own IR brings that file back
with it.

**Test.** Extend `lib/__tests__/section-presets.test.ts`: resolving a preset
that omits `convolveIrFile` returns no entry for it; one that names it returns
the path.

## Phase 2 — The sequencer is unreachable

**Defect.** `getModulatorParamKeys` lists 14 keys, none of them `Seq*`. Reset,
Randomise and presets all miss the sequencer entirely.

Add to that list, per modulator index:

| Key            | Kind   | Range   | Default    |
| -------------- | ------ | ------- | ---------- |
| `SeqStepsX`    | number | 1–16    | 8          |
| `SeqStepsY`    | number | 1–8     | 4          |
| `SeqLoopBeats` | number | 1/64–32 | 1          |
| `SeqLoopSemis` | number | 1–96    | 12         |
| `SeqSwing`     | number | 0–100   | 0          |
| `SeqData`      | string | JSON    | 4×8 of `1` |

`SeqData` is `{"values": number[rows][cols]}` with cells **continuous 0–1**, not
on/off — the grid paints intensities. `values[row][col]`, and **row 0 is the
bottom of the grid**, the lowest band: both `getStepFromPos` and `drawCanvas` in
`controls/sequencer-grid.tsx` flip Y to match the texture.

**Checked:** widening the list also widens Randomise, but `handleRandomize`
switches on `def.kind` and returns on anything that is not a number, option or
boolean, so the `SeqData` string is left alone. Reset writes its default grid,
which is what Reset should do.

---

## Phase 3 — Content

53 presets across eight sections, mixing what an effect is usually asked to do
with what it can be pushed into. Every value below is inside its parameter's
range, which `section-presets.test.ts` already enforces.

### Clone — 6

Keys: `cloneSpaceBeats` (−32…32), `cloneSpaceSemis` (−96…96), `cloneCountX`
(1–64), `cloneCountY` (1–64), `cloneDecay` (0–100), `cloneDirectionX`
(0 Forward, 1 Middle, 2 Backward), `cloneDirectionY` (0 Up, 1 Middle, 2 Down),
`cloneShapeX`/`cloneShapeY` (`"even" | "harmonic" | "geometric" | "inharmonic"`,
plus `"scale"` on the pitch axis), `cloneSumMode` (0 Coherent, 1 Constructive),
`cloneEdgeMode`.

| Name            | Blurb                                                       | Values                                                              |
| --------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Delay           | Eight echoes a sixteenth apart, each quieter than the last. | SpaceBeats .25, CountX 8, CountY 1, Decay 60, DirX 0, Sum 0         |
| Octaves         | Stacks octaves above without letting them cancel.           | SpaceSemis 12, CountY 3, CountX 1, DirY 0, Sum 1, Decay 40          |
| Harmonic Series | Builds a harmonic stack on whatever it covers.              | CountX 1, CountY 8, ShapeY harmonic, SpaceSemis 12, Sum 1, Decay 30 |
| Bouncing Ball   | Echoes that crowd together as they fade.                    | SpaceBeats .5, CountX 8, ShapeX harmonic, Decay 70, Sum 0           |
| Comb            | Copies close enough together to cancel each other.          | SpaceBeats .01, CountX 16, Decay 0, Sum 0                           |
| Struck Bar      | An inharmonic stack, like a piano's top octave.             | CountY 7, ShapeY inharmonic, SpaceSemis 12, Sum 1, Decay 35         |

### Evolve — 6

Keys: `evolveFlow`, `evolveSpread`, `evolveGrow`, `evolveSwirl`, `evolveDriftX`,
`evolveDriftY`, `evolveDecay` (all −100…100), `evolveScaleX`, `evolveScaleY`
(−100…100), `evolveEdgeMode`.

| Name  | Blurb                                 | Values                                            |
| ----- | ------------------------------------- | ------------------------------------------------- |
| Smear | Diffusion with no motion behind it.   | Spread 80, Flow 0, ScaleX 60, ScaleY 20           |
| Erode | Thins the material away.              | Decay 40, Spread 50, Grow −20                     |
| Climb | Content creeps upward in pitch.       | Flow 40, DriftY 60, Spread 30                     |
| Bloom | Material grows until it takes over.   | Grow 70, Spread 60, Decay −20                     |
| Swirl | Smearing with a rotation in it.       | Swirl 80, Flow 50, Spread 20                      |
| Boil  | Small-scale churn that never settles. | Grow 50, Decay 40, Swirl 40, ScaleX 20, ScaleY 20 |

### Binaural — 5

Keys: `binauralAzimuth` (−180…180°), `binauralDistance` (0.1–10 m),
`binauralStereoAngle` (0–180°).

| Name      | Blurb                           | Values                                |
| --------- | ------------------------------- | ------------------------------------- |
| Left      | Hard to the left.               | Azimuth −90, Distance 1, Stereo 120   |
| Right     | Hard to the right.              | Azimuth 90, Distance 1, Stereo 120    |
| Behind    | Directly behind the head.       | Azimuth 180, Distance 1.5, Stereo 120 |
| Distant   | Far off, and dulled by the air. | Distance 6, Azimuth 0, Stereo 60      |
| Too Close | Nearer than anything should be. | Distance 0.1, Azimuth 0, Stereo 180   |

### Sort — 5

Keys: `sortDirection` (0 Horizontal, 1 Vertical, 2 Both), `sortOrder`
(0 Forwards, 1 Backwards), `sortBy` (0 Magnitude, 1 Phase, 2 dB, 3 Frequency,
4 Pan), `sortStereoMode` (0 Linked, 1 Independent).

| Name          | Blurb                                 | Values                               |
| ------------- | ------------------------------------- | ------------------------------------ |
| Gather Up     | Loud content collects toward the top. | Direction 1, Order 0, By 0, Stereo 0 |
| Smear Time    | Sorts along time by level.            | Direction 0, Order 0, By 2, Stereo 0 |
| Spectral Ramp | Reorders the bands by frequency.      | Direction 1, Order 0, By 3, Stereo 0 |
| Stereo Tear   | Pulls the stereo image apart.         | Direction 0, Order 0, By 4, Stereo 1 |
| Glitch        | Both axes, by phase, channels loose.  | Direction 2, Order 1, By 1, Stereo 1 |

### Reflow — 6

Keys: `reflowMode` (0 Scale, 1 Pitch, 2 Stretch), `reflowAmount` (−100…200%),
`reflowPitch` (−48…24 st), `reflowStretch` (−2…3), `reflowReach` (0.1–48 st).

| Name          | Blurb                                                  | Values                                     |
| ------------- | ------------------------------------------------------ | ------------------------------------------ |
| Snap to Scale | Pulls every pitch onto the transport's scale.          | Mode 0, Amount 100, Reach 12               |
| Nudge         | Light correction, nothing travels far.                 | Mode 0, Amount 50, Reach 3                 |
| Detune        | Pushes pitches away from the scale instead of onto it. | Mode 0, Amount −30, Reach 6                |
| Monotone      | Everything onto a single pitch.                        | Mode 1, Amount 100, Pitch −12, Reach 48    |
| Spread        | Bends the partials sharp.                              | Mode 2, Stretch 1.5, Pitch −12, Amount 100 |
| Collapse      | Every partial onto one point.                          | Mode 2, Stretch 0, Pitch −12, Amount 100   |

### Convolve — 5

Keys: `convolveIrTimeOffset` (0–100%), `convolveIrPitchShift` (−24…24 st),
`convolveIrSize` (1–512 taps), `convolveIrRate` (−256…256), `convolveGainDb`
(−36…36 dB), `convolveEdgeMode`. **None names `convolveIrFile`**, so each is a
tail shape for whichever IR is loaded — see Phase 1.

| Name      | Blurb                                      | Values                           |
| --------- | ------------------------------------------ | -------------------------------- |
| Room      | A short, close tail.                       | Size 48, Start 0, Rate 1, Gain 0 |
| Hall      | A long one.                                | Size 256, Rate 1, Gain −3        |
| Gated     | Cut off before it can decay.               | Size 24, Start 0, Gain 3         |
| Reverse   | The tail runs backwards.                   | Rate −1, Size 128                |
| Stretched | The tail smeared to four times its length. | Rate 0.25, Size 256              |

### Modulator — pattern and envelope, 10

Keys are stored without the modulator index: `Mode` (0 Pattern, 1 Envelope,
2 Sequencer), `PatternShape`, `PatternRateBeats` (0–32, 0 = off on that axis),
`PatternRateSemis` (0–96), `Rotation` (0–360°), `PhaseMode` (0 Canvas, 1 Brush),
`PhaseX`/`PhaseY` (0–100%), `Strength` (−100…100%), `StereoSpread`,
`EnvelopeSource` (0 Amplitude, 1 Phase, 2 Panning), `EnvelopeSmoothingBeats`
(0–4), `EnvelopeMinDb`, `EnvelopeMaxDb`.

Shapes: 0 Sine, 1 Triangle, 2 Square, 3 Sawtooth, 4 Pulse, 5 Random, 6 Smooth
Noise, 11 Selected Scale, 13 Quilt, 14 Clouds, 15 Cells, 16 Bubbles,
17 Craters, 18 Ripples, 19 Scratches, 20 Swirls, 21 Paper, 22 Marble, 23 Weave,
24 Terrain, 25 Flow.

| Name            | Blurb                                             | Values                                                   |
| --------------- | ------------------------------------------------- | -------------------------------------------------------- |
| Slow Sweep      | One cycle every eight beats, unchanging in pitch. | Mode 0, Shape 0, RateBeats 8, RateSemis 0                |
| Bar Ramp        | Rises across each bar and drops back.             | Mode 0, Shape 3, RateBeats 4, RateSemis 0                |
| Pitch Stripes   | Varies with pitch alone, an octave per cycle.     | Mode 0, Shape 0, RateBeats 0, RateSemis 12               |
| Scale Bands     | Follows the notes of the transport's scale.       | Mode 0, Shape 11, RateSemis 12, RateBeats 0              |
| Random Steps    | A new random value for each beat and each octave. | Mode 0, Shape 5, RateBeats 1, RateSemis 12               |
| Clouds          | A soft field over both time and pitch.            | Mode 0, Shape 14, RateBeats 4, RateSemis 24, PhaseMode 0 |
| Ripples         | Diagonal interference.                            | Mode 0, Shape 18, RateBeats 2, RateSemis 24, Rotation 45 |
| Marble          | Veined texture, slow across the file.             | Mode 0, Shape 22, RateBeats 8, RateSemis 36              |
| Follow Loudness | Tracks the material's own level.                  | Mode 1, EnvelopeSource 0, Smoothing 0.25, Min −60, Max 0 |
| Follow Panning  | Tracks where the material sits in the image.      | Mode 1, EnvelopeSource 2, Smoothing 0.5                  |

### Modulator — sequencer, 10

All set `Mode` 2. `SeqData` grids are written below as pictures; `·` is 0 and
`█` is 1, with the intermediate rows spelled out where they matter.

| Name              | Blurb                                                 | Grid                        | Rest                      |
| ----------------- | ----------------------------------------------------- | --------------------------- | ------------------------- |
| Four on the Floor | On every other step of the bar.                       | `█·█·█·█·` 8×1              | LoopBeats 4               |
| Offbeat           | The steps the last one leaves out.                    | `·█·█·█·█` 8×1              | LoopBeats 4               |
| Euclid 3/8        | Three hits spread over eight steps.                   | `█··█··█·` 8×1              | LoopBeats 4               |
| Swung Eighths     | Eighths with the offbeats softened and pushed late.   | `█▄█▄█▄█▄` 8×1              | LoopBeats 4, Swing 60     |
| Breathe           | Swells in and back out across the bar.                | 16×1 ramp up and down       | LoopBeats 4               |
| Decay Hits        | Each hit falls away instead of holding.               | `1 .5 .2 0` ×2, 8×1         | LoopBeats 4               |
| Checkerboard      | Neighbouring bands get opposite halves of the rhythm. | 8×4 alternating both axes   | LoopBeats 4, LoopSemis 24 |
| Staircase         | The modulation climbs the spectrum as the bar runs.   | 8×4 diagonal                | LoopBeats 4, LoopSemis 24 |
| Pitch Comb        | Stripes up the spectrum, no change over time.         | 1 col × 8 rows alternating  | LoopSemis 12              |
| Scatter           | A different value in every band and every sixteenth.  | 16×8 of fixed random values | LoopBeats 8, LoopSemis 48 |

Grids in full:

```
Four on the Floor  [[1,0,1,0,1,0,1,0]]
Offbeat            [[0,1,0,1,0,1,0,1]]
Euclid 3/8         [[1,0,0,1,0,0,1,0]]
Swung Eighths      [[1,0.55,1,0.55,1,0.55,1,0.55]]
Breathe            [[0.13,0.25,0.38,0.5,0.63,0.75,0.88,1,
                     1,0.88,0.75,0.63,0.5,0.38,0.25,0.13]]
Decay Hits         [[1,0.5,0.2,0,1,0.5,0.2,0]]
Checkerboard       [[1,0,1,0,1,0,1,0],
                    [0,1,0,1,0,1,0,1],
                    [1,0,1,0,1,0,1,0],
                    [0,1,0,1,0,1,0,1]]
Staircase          [[1,0,0,0,1,0,0,0],
                    [0,1,0,0,0,1,0,0],
                    [0,0,1,0,0,0,1,0],
                    [0,0,0,1,0,0,0,1]]
Pitch Comb         [[1],[0],[1],[0],[1],[0],[1],[0]]
Scatter            8 rows × 16 cols, literal values
```

**Scatter must be a literal.** Generating it with `Math.random()` at module load
would give a different grid on every launch, so a preset would stop being a
preset. Roll one once and paste it in.

### Not getting presets

- **Align** has no parameters (`align: []`). Nothing to preset.
- **Synthesize** has one option, `synthesizeBrushType`. A list would be the
  dropdown again, one row per entry.
- **Transmute** and **Waveshape** are hidden from the Add Effect picker, so
  only a brush that already carries one would ever see the list. Worth doing
  last, if at all: Phase Quantize, Phase Gate, Fold and Wrap are the obvious
  entries.

---

## Phase 4 — Docs

- `docs/manual.md` → **Section Presets** describes the mechanism, plus one line
  on presets that name a file. Nothing per effect; the lists explain themselves
  in the UI.
- Blurbs follow `docs/copy-style.md`: British spelling, sentence case, one
  sentence, warm rather than clinical — these are effect-card copy, not
  tooltips.
- Names are Title Case and short enough not to truncate in a 112 px column.

## Verification

- `npm run test:run` — the guard tests fail the build on a preset that names a
  parameter outside its own section, holds a value outside range, or ships a
  sequencer grid whose shape disagrees with its step counts.
- `section-presets-store.test.ts` covers the Phase 1 rule at the store: an
  unnamed file parameter is never written, a named one is written and opened.
- By hand, in a build: applying **Hall** with an IR loaded left the IR in place
  and moved Taps to 256 and Gain to −3 dB; applying **Checkerboard** switched
  the modulator to Sequencer and redrew the grid.

## Still open

1. **Descriptions on factory presets** are shown only as a hover tooltip. The
   modulator list is now 20 rows, ten of them visible — a second line per row
   may read better than a tooltip at that length.
2. **The modulator list holds every colour there is.** The palette is 20, so a
   preset saved on top of the 20 factory ones repeats one.
3. **`convolveEdgeMode` is not in `EFFECT_PARAMS.convolve`,** so Reset,
   Randomise and presets all skip it. Adding it widens all three.
