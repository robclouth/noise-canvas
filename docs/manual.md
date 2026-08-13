# Noise Canvas — Manual

The complete guide to Noise Canvas. For downloads, installation, and build instructions, see the [README](../README.md).

Every control in the app has a tooltip and an entry in the `?` overlay, and how to use a tool should be mostly obvious just by using it — this manual is for when it isn't.

## Contents

1. [Core Concepts](#core-concepts)
2. [The Interface](#the-interface)
3. [Brushes](#brushes)
   - [The Brush List](#the-brush-list)
   - [Steps](#steps)
   - [Macros](#macros)
   - [Source](#source)
   - [Envelope](#envelope)
   - [Options](#options)
   - [Warp Algorithms](#warp-algorithms)
   - [Blend Modes](#blend-modes)
4. [Effects](#effects)
   - [Dynamics](#dynamics) · [Transform](#transform) · [Blur](#blur) · [Clone](#clone) · [Synthesize](#synthesize) · [Evolve](#evolve) · [Binaural](#binaural) · [Sort](#sort) · [Transmute](#transmute) · [Waveshape](#waveshape) · [Convolve](#convolve) · [Align](#align)
5. [Modulation](#modulation)
   - [How Modulation Amount Works](#how-modulation-amount-works)
   - [Modulator Modes](#modulator-modes)
   - [Pattern Shapes and Images](#pattern-shapes-and-images)
   - [Modulator Controls](#modulator-controls)
   - [Contextual Sources](#contextual-sources)
   - [Nested Modulation](#nested-modulation)
6. [Fill Grid](#fill-grid)
   - [What Sets the Spacing](#what-sets-the-spacing)
   - [What Sets the Size](#what-sets-the-size)
   - [Filling Part of a File](#filling-part-of-a-file)
   - [Variation Between Strokes](#variation-between-strokes)
7. [Parameter Controls](#parameter-controls)
   - [Section Presets](#section-presets)
   - [Randomization](#randomization)
   - [Linking Parameters Across Steps](#linking-parameters-across-steps)
8. [Working with Files](#working-with-files)
   - [Splitting a File](#splitting-a-file)
   - [Stem Groups](#stem-groups)
   - [Onsets](#onsets)
   - [Navigating the Canvas](#navigating-the-canvas)
9. [History](#history)
10. [Transport and Output](#transport-and-output)
11. [Menus](#menus)
12. [Keyboard Shortcuts](#keyboard-shortcuts)
13. [Getting Help](#getting-help)
14. [Where Things Are Saved](#where-things-are-saved)
15. [Working with Ableton Live](#working-with-ableton-live)

---

## Core Concepts

At its heart, Noise Canvas is about **painting sound directly into a spectrogram**.

A spectrogram is a visual representation of sound where:

- The **horizontal axis** is **time** (measured in beats)
- The **vertical axis** is **pitch** (measured in semitones)
- The **brightness or color** represents **amplitude**

When you load an audio file, Noise Canvas analyzes it into this form using the **Constant-Q Transform (CQT)** — which gives a musically intuitive frequency layout.
Instead of abstract FFT bins, you're working in **beats and notes**. That means everything you draw, erase, blur, shift, or distort corresponds directly to musical structure.

Crucially, the app stores **complex** coefficients — magnitude _and_ phase — not just a picture. Effects operate on both, which is why transients survive being moved around, why stereo and binaural work at all, and why the results resynthesize back to real audio rather than to a vocoder-y approximation.

The workflow is simple:

1. Load a sound.
2. Build a brush out of one or more effects.
3. Paint across time and pitch.
4. Hear the results instantly.

This approach makes sound design tangible — almost physical. You're literally **painting timbre**.

You can load **multiple audio files** at once and choose which one acts as the source (where data is pulled from) and which as the target (where data is painted to). A branching history and versioned saving let you experiment freely without fear of breaking anything.

### Why Constant-Q

The Constant-Q Transform adjusts time resolution based on frequency:

- Low frequencies → lower time resolution (smeared in time, accurate in pitch)
- High frequencies → higher time resolution (precise in time, less in pitch)

This matches human hearing and avoids the artificial "FFT sound," producing more natural transients and harmonics.

### Analysis Resolution

Where a file sits on that trade-off is fixed when it is analyzed, and shown as a badge in its header. Change it with **Resolution** in the Re-analyze dialog. The setting is bands per octave: more bands separate pitches more finely, and each band then needs a longer window to do it, which smears events in time.

| Badge            | Bands/octave | What it does                                                                                 |
| ---------------- | ------------ | -------------------------------------------------------------------------------------------- |
| **Best Time**    | 12           | Sharpest transients, coarsest pitch. Drums, percussive edits, anything where attacks matter. |
| **Better Time**  | 24           | Leans toward time, still separates notes usefully.                                           |
| **Balanced**     | 36           | The default. Handles pitched material and transients without favouring either.               |
| **Better Pitch** | 48           | Leans toward pitch, at some cost to attacks.                                                 |
| **Best Pitch**   | 60           | Finest pitch separation, softest transients. Pads, drones, harmonic work.                    |

The choice affects what edits sound like, not just how the spectrogram looks: a shift or stretch is reconstructed from these bands, so a file analyzed at 12 bands per octave keeps its clicks crisp while one at 60 keeps its harmonics clean.

---

## The Interface

The window is split into three columns plus a transport bar:

- **Left — Brush panel.** Everything that defines the current brush: Macros, Steps, Source, Envelope, Options, Effects, Modulators.
- **Middle — Canvas.** Every open file stacked vertically, each with its own header, time legend, and pitch legend. Minimized files collapse into the dock at the bottom.
- **Right — Sidebar.** The brush list on top, the history tree below.
- **Bottom — Transport.** Playback, grid, scale, meters, limiter, Ableton Link.

**Compact UI** (`Cmd/Ctrl+Shift+C`, or **View → Compact UI**) shrinks every control so more fits on smaller screens.

---

## Brushes

Everything in Noise Canvas revolves around the brush — it's the link between what you see and what you hear.

When you paint, the brush defines **where** and **how strongly** an effect is applied to the spectrogram. Effects are modular: you can enable several at once, tweak them independently, and reorder them to change their processing order.

### The Brush List

Brushes live in the right-hand sidebar. You can have as many open as you like; each is an independent set of steps, effects, modulators, and macros.

- A **colour bar** down the left edge identifies each brush; the same colour marks it wherever it is referenced.
- **Hover** a row to see what is in it: each step's effects, in order.
- **Click** a row to make it active. **Double-click** the name to rename.
- The **⋮ menu** offers Rename, Duplicate, Save, Save as…, Load referenced files, Assign key…, Remove key, and Close.
- **Drag** rows to reorder them.
- **Add brush** at the bottom of the list opens the picker: **New** for an empty brush, or any preset below it.

**Hotkeys.** Any brush can be bound to a letter key (⋮ → _Assign key…_, then press a letter). Pressing that letter anywhere in the app jumps straight to that brush. The number keys **1–9 and 0** always select the first ten brushes in the list, no assignment needed.

**The library.** Brushes are saved as JSON presets in `Documents/Noise Canvas/Presets/`. A brush loaded from the library remembers where it came from — _Save_ overwrites it, _Save as…_ creates a new one. A dirty marker appears when the brush has drifted from its saved version. A set of factory presets ships with the app:

> Eraser · Booster · Restore · Stereo Widening · Compressor · Noise Gate · Smudge · Octave Up · Octave Down · Reverse · Low-Pass Sweep · High-Pass · Harmonics · Reverb (Blur) · Echo · Paint Noise · Paint Tone · Flow · Pixel Sort · Tremolo · Step Gate · Dynamic Bloom · 3D Orbit · Shimmer · Morph (Macros) · Sampler · Convolution

Some factory brushes reference bundled audio (an IR, a pad loop). Those load automatically; _Load referenced files_ re-opens them if you closed them.

### Steps

A brush can have up to **5 steps**, shown as a tab strip. Each step is a complete, independent set of brush parameters and effects, and a single stroke runs through **all** of them in order. This is how you build multi-stage moves — e.g. step 1 synthesizes a tone, step 2 blurs it, step 3 spatializes it.

- Steps carry a persistent colour, so reordering reads as moving an identity rather than relabelling a slot.
- **Drag** to reorder, **Duplicate** and **Delete** from the buttons on the right.
- The strip is fixed-width, so adding or removing a step never rescales the others.

Almost every brush and effect parameter is **per-step**. The exceptions are the genuinely global ones: the grid, the scale, and the transport settings.

### Macros

Four renamable **Macros** per brush. A macro is just a knob that can modulate any modulatable parameter, at any depth, positive or negative — good for collapsing a complicated brush down to one or two performance controls. Rename them from the parameter label menu (pencil icon).

### Source

By default a brush reads from the file it's painting on. The **Source** section changes that:

- **Source** — hold **Shift** (or click the Source control to arm it) and click on any open file's canvas to pick a source file and position. A brush-sized rectangle previews where you're sampling from. This is the clone-stamp.
- **Tracking** — how the source position is used:
  - **Follow** — the source moves along with your stroke.
  - **Fixed** — always samples from that exact position.
  - **Anchored** — keeps a fixed offset relative to where the stroke started.
- **Time ↔ / Pitch ↕** — explicit source position, as a percentage of the source file (disabled in Follow mode, and both are modulatable).
- **Read From** — **Current** paints using the source file's edited state, **Original** paints from its unedited analysis. This is how the "Restore" brush works.

Painting between files with different tempos, lengths, or analysis resolutions is supported — positions are mapped through a frequency-preserving map so the geometries don't have to agree.

### Envelope

The brush envelope decides where the stroke deposits energy and how much.

- **Strength** – how strongly the effect applies.
- **Anchor** – where the cursor sits on the brush. **Corner** puts the cursor at the onset (bottom-left) corner, so snapping locks onsets to the beat grid — best for rhythmic strokes. **Center** puts the cursor at the brush centre, so snapping puts the envelope peak on the grid — best for soft/ambient strokes.
- **Size ↔ (beats) / Size ↕ (semitones)** – brush size. At the minimum ("Grid") the brush tracks the current grid spacing; at the maximum ("Full") it fills the whole file in that axis and anchors to the edge.
- **Curve ↔ / ↕** – shape of the envelope in each axis: −100% is a sharp spike, 0% a linear triangle, +100% a hard rectangle. Lower the curve for softer edges.
- **Skew ↔ / ↕** – where the envelope peak sits. For time, −100% is an early pluck, 0% centred, +100% a delayed hit; for pitch, −100% bottom, +100% top.

### Options

- **Blend mode** – how the processed and original spectrogram are combined (see below).
- **Pan** – stereo positioning of the processing.
- **Iterations** – how many times the effect chain recursively re-applies within one stroke (feedback, echoes, spectral delays).
- **Wrap** – behaviour when painting off the canvas edges: Off, Time, Pitch, or Time & Pitch.
- **Warp algo** – resynthesis strategy (see below).
- **Accumulate** – when on, painting over the same area builds up; when off, a single stroke won't overlap itself, so dragging back and forth doesn't double-apply.

### Warp Algorithms

When content is moved in time or pitch, its phase has to be reconstructed. Each strategy has its own character and its own artifacts — pick what sounds best:

| Algorithm      | Character                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Neutral**    | Default. The faithful general-purpose rule. Transients are re-anchored at detected onsets so clicks stay sharp instead of smearing into pre-echo, and sustained tonal material is left as it was. |
| **Neutralish** | An earlier neutral rule that also compensates for shifts. Slightly different smear character.                                                                                                     |
| **Percussive** | Snappy, aggressive re-anchoring. Emphasises attacks.                                                                                                                                              |
| **Flangey**    | Keeps stored phase as-is. Comb-filtered, metallic.                                                                                                                                                |
| **Noisey**     | Randomizes phase. Diffuse and airy.                                                                                                                                                               |

### Blend Modes

How the processed data merges with the original spectrogram:

- **Mix** – normal crossfade.
- **Add** – adds the processed signal.
- **Subtract** – removes the processed values.
- **Multiply / Divide** – scale relationships.
- **Maximum / Minimum** – keep stronger or weaker values.
- **Difference** – absolute difference between source and result.
- **Dissolve** – noisy probabilistic mixing, like Photoshop's dissolve.
- **Mask** – a self-normalizing relative-energy gate: the original is kept only where the processed result also has energy.
- **Screen** – Photoshop-style brightening (inverse multiply).

---

## Effects

Add effects with **Add effect** at the bottom of the Effects section — the picker lays them out in two columns with a description for each. A step holds **up to 10 effects**, and you can add several instances of the same effect, each with its own independent settings.

Each effect header has a **checkbox** that bypasses it, a **title that doubles as the drag handle** for reordering, and a **⋮ menu** with Duplicate, Reset to defaults, and Remove.

> **Transmute** and **Waveshape** are currently hidden from the Add Effect picker. They still work, and still run in any brush that already uses them, but you can't add a new instance from the UI. They're documented below anyway.

Several effects share an **Edge Mode** that decides what happens to content that spills past the brush border: **Cut** (discard it), **Bleed** (pull in surrounding content), **Wrap** (wrap around the edge), **Clamp** (hold the edge value), **Reflect** (ping-pong flip), or **Invert**.

### Dynamics

Compression, expansion, gating, and inversion, per spectrogram bin.

- **Threshold** – amplitude threshold in dB.
- **Upper** – gain applied above the threshold (1 = unity, 0.5 = compress, 2 = expand, 0 = gate, −1 = invert).
- **Lower** – gain applied below the threshold.
- **Knee** – width of the transition zone around the threshold, in dB.
- **Gain** – overall output gain in dB.

### Transform

Shifts, scales, and rotates the spectral image.

- **Shift ↔ / ↕** – move content in time (beats) or pitch (semitones).
- **Scale ↔ / ↕** – stretch or compress in time or pitch. Negative values reverse/mirror.
- **Rotation** – rotate the painted region, in degrees.
- **Edge** – behaviour at the brush borders.

### Blur

Smooths and blends over time and pitch — echo, reverb, and diffusion-like effects.

- **Blur ↔ / ↕** – degree of blur in time / pitch.
- **Noise ↔ / ↕** – random scattering to make the blur more diffuse.
- **Samples ↔ / ↕** – blur kernel sample count (quality vs. speed).
- **Edge** – behaviour at the brush border.
- **Origin** – where the blur radiates from: Left (forward reverb), Middle (symmetrical), Right (reversed).

### Clone

Stamps beat- and semitone-spaced copies of the painted region in 2D — echoes, spectral delays, stacked harmonics.

- **Space ↔ / ↕** – spacing between copies in beats / semitones (can be negative). With any shape other than Even this is the gap to the _first_ copy, and the shape sets the rest.
- **Copies ↔ / ↕** – number of copies along each axis (1–64).
- **Shape ↔ / ↕** – how the gaps grow from copy to copy. See the table below.
- **Dir. ↔ / ↕** – Forward/Middle/Backward and Up/Middle/Down.
- **Decay** – fade applied to each successive copy; the two axes multiply.
- **Edge** – behaviour for copies extending past the border.
- **Sum** – Coherent adds the copies as waves, so overlapping copies can cancel and comb. Constructive adds their levels and averages their phase against the first copy, so a stack never cancels.

An axis set to 1 copy costs nothing: that pass is skipped entirely.

#### Shapes

Every shape places the first copy one **Space** value out, so switching shape never moves it. Only the copies past it move.

| Shape ↕   | Shape ↔     | Gaps                                                                             |
| ---------- | ------------ | -------------------------------------------------------------------------------- |
| Even       | Even         | All the same. Space ↕ = 12 gives octaves, 7 gives fifths.                       |
| Harmonic   | Decelerating | The natural harmonic series — gaps shrink as they climb.                         |
| Geometric  | Accelerating | Every gap is twice the one before.                                               |
| Inharmonic | Uneven       | The harmonic series stretched sharp, like a struck bar or a piano's top octaves. |
| Scale      | —            | The degrees of the scale set in the transport bar.                               |

Even is the only shape with even gaps, and it is the only one a modulator can reach — modulation stretches the whole comb at once, so it cannot make gaps unequal. That is what shapes are for.

Set **Copies ↔** to 1, **Shape ↕** to Harmonic, **Space ↕** to 12 and **Sum** to Constructive and Clone stacks a harmonic series on whatever it covers. **Space ↕** then doubles as the stretch: above 12 the partials spread sharp, below 12 they compress.

### Synthesize

Fills the brushed area with generated material.

- **Type** – Noise, Sine, or Impulse. (Impulse plus a tight envelope is how you draw hats, snares, and kicks from nothing.)

### Evolve

A reaction–advection–diffusion simulation, for fluid, biological, and chaotic patterns.

- **Flow** – advection strength along the gradient (negative reverses).
- **Spread** – diffusion (positive spreads, negative sharpens).
- **Grow** – reaction strength (positive grows, negative shrinks).
- **Swirl** – adds a rotational component to the flow.
- **Drift ↔ / ↕** – directional bias in time / pitch.
- **Decay** – entropy / death rate (negative boosts).
- **Scale ↔ / ↕** – kernel size in time / pitch.
- **Edge** – behaviour at the brush border.

### Binaural

HRTF-based binaural spatialization for 3D placement of the painted region.

- **Azimuth** – horizontal angle (0° front, 90° right, −90° left, ±180° behind).
- **Distance** – source distance in metres (affects level and high-frequency absorption).
- **Stereo** – stereo spread around the azimuth (0° = mono, 180° = full L/R offset).

### Sort

Odd-even transposition sort of the spectrogram bins — pixel-sorting, for sound.

- **Direction** – Horizontal, Vertical, or Both.
- **Order** – Forwards or Backwards.
- **Sort By** – Magnitude, Phase, dB, Frequency, or Pan.
- **Stereo** – sort channels Linked or Independent.

### Transmute

Low-level polar operations on the raw magnitude and phase of each bin.

- **Mode** – Swap Mag/Phase, Complex Power, Phase Rotate, Phase Quantize, Stereo Cross, or Phase Gate.
- **Amount** – the primary parameter for the selected mode.
- **Curve** – secondary shaping for the modes that use it.

### Waveshape

Waveshaper distortion applied to the rectangular (real/imaginary) spectral components.

- **Shape** – Soft Clip, Hard Clip, Rectify, Fold, Wrap, or Sine.
- **Drive** – gain before shaping. For Fold/Wrap/Sine this controls how many times the signal cycles through the nonlinearity.
- **Tilt** – skews the real/imaginary balance before shaping, biasing the phase distribution.

### Convolve

Time-axis convolution with an impulse-response spectrogram — reverbs, room tones, and other IR-based effects. IR loudness is auto-normalized so swapping IRs doesn't blow up the level.

- **IR** – the impulse-response file, chosen from your open files.
- **Taps** – number of IR frames applied (longer, more expensive tail).
- **Start** – where in the IR the first tap begins.
- **Pitch Shift** – pitch shift applied to the IR, in semitones.
- **Rate** – source read rate per tap (1 = forward, −1 = reverse; other values stretch or compress the tail).
- **Gain** – output gain of the convolution, in dB.
- **Edge** – behaviour for taps extending past the border.

### Align

No parameters. Phase-aligns every band at the start of the brush to form a sharp impulse, then fades back to the original phase. Use it to manufacture transients out of noise, or to tighten up an attack that's gone smeary.

### Reflow

Retunes whatever the brush covers by rewriting phase trajectories. Each band's true pitch is measured from its phase motion, averaged across the brush span, and pulled toward a target — magnitudes are never touched, so the retune stays clean within about a semitone of movement. The rewrite is anchored at the brush start.

- **Mode** – Scale snaps each pitch to the nearest note of the global scale; Pitch pulls everything toward one pitch; Stretch bends the spectrum around a fixed point.
- **Amount** – how far pitches move toward their target. Negative pushes away from it; past 100 overshoots.
- **Pitch** – the target for Pitch mode and the fixed point for Stretch, in semitones from A4.
- **Stretch** – the exponent for Stretch mode: 1 leaves spacing alone, above 1 spreads the spectrum apart, 0 collapses it onto the fixed point, negative mirrors it.
- **Reach** – pitches farther than this from their target stay put, in semitones.

---

## Modulation

Noise Canvas has a deep modulation system for automating parameters across time and pitch. Anywhere a parameter label opens a menu with a **Modulation** section, that parameter is modulatable. You get **three modulators** per step, plus four macros and eight contextual sources.

Modulation is evaluated **per pixel**, not per stroke — a modulator is a 2D field over the spectrogram, not an LFO on a timeline.

### How Modulation Amount Works

This isn't an "add some LFO on top" system. Think of it as **crossfading between the parameter's slider value and a fully modulated value that is always clamped to the parameter's legal range**.

- **Amount = 0%** → The parameter is **exactly** the value you set on its slider. No modulation is applied.
- **Amount = +100%** → The parameter ignores the slider and takes **pure modulation**, mapped from **that parameter's minimum up to its maximum**. It **never** goes out of range.
- **Amount = −100%** → Same as +100% but **inverted**: the modulator is mapped from **maximum down to minimum**.
- **Amounts in between** blend between the slider value and the modulated value.

The parameter menu shows the resulting **live range in real units** next to the Modulation header, so you can dial amounts in against concrete values rather than abstract percentages.

### Modulator Modes

- **Pattern** – a 2D shape scrolled across time and pitch.
- **Envelope** – follows the painted region's own **Amplitude**, **Phase**, or **Panning**, with adjustable smoothing window (in beats) and dB range.
- **Sequencer** – a step grid you draw on: adjustable steps (1–16), rows (1–8), loop length in beats, pitch range in semitones, and swing.

### Pattern Shapes and Images

**Waveforms:** Sine, Triangle, Square, Sawtooth, Pulse, Random, Smooth Noise.

**Procedural textures:** Quilt, Clouds, Cells, Bubbles, Craters, Ripples, Scratches, Swirls, Paper, Marble, Weave, Terrain, Flow.

**Selected Scale** — snaps modulation to the scale set in the transport bar.

**Images** — a set of factory textures ships with the app, and you can drop your own images in:

```
Documents/Noise Canvas/Textures/
```

They appear in the shape picker under a "User" group.

### Modulator Controls

- **Depth** – modulation intensity (bipolar; negative inverts).
- **Rate ↔** – how many beats one cycle of the pattern spans. Bigger is slower. At 0 ("Off") the pattern stops varying along time.
- **Rate ↕** – how many semitones one cycle spans. At 0 ("Off") it stops varying along pitch.
- **Rotation** – rotates the pattern.
- **Stereo** – decorrelates the left/right channels by offsetting the sample position in time. Negative values swap channels.
- **Phase Mode** – whether the pattern is anchored to the **Canvas** (fixed in the file, so strokes reveal a stationary pattern) or to the **Brush** (travels with each stroke).
- **Phase ↔ / ↕** – offsets the pattern's start position in each axis.

### Contextual Sources

Beyond the three modulators and four macros, every modulatable parameter can also be driven by stroke properties:

**Iteration** (index across brush iterations) · **Time Pos.** (position across the file) · **Pitch Pos.** (position across the frequency range) · **Randomize** (a random value per stroke) · **Step** (index across steps) · **Pressure**, **Tilt X**, **Tilt Y** (pen tablet input).

### Nested Modulation

Modulator parameters are themselves modulatable — you can modulate modulator 2's rate with modulator 1, or drive a modulator's depth from a macro. One level of nesting is supported.

> Nested modulation is disabled on Windows, where the unrolled shader loops it produces make compile times unusable.

---

## Fill Grid

**Fill Grid** paints the current brush on every cell of the grid, in one pass. The grid icon on a file's header runs it, as does **Edit → Fill Grid with Brush** (`Cmd/Ctrl+G`). The whole pass commits as one stroke, one history step, and one resynthesis, so a single undo takes it back.

A fine grid over a long file can run to thousands of strokes. Nothing is refused: a large fill paints in the background behind a progress dialog, and **Cancel** stops it and puts back the pixels from before it started.

Nothing here has its own rhythm settings. The fill reads the grid you already set, so everything the grid can express, the fill can paint.

### What Sets the Spacing

**Time** comes from **Beats** and **Swing** in the transport. A one-beat grid paints on every beat; a sixteenth grid paints sixteen to the bar. Swing carries straight through, so an off-eighth lands late and its cell is wider — a swung fill tiles without gaps.

Set the time grid to **Onsets** and the fill lands on the file's own detected hits instead of a fixed division. Each stroke then runs from its hit to the next, so an uneven performance is followed rather than flattened.

**Pitch** comes from **Semis**. A 12-semitone grid paints one row per octave. Set it to **Scale** and the fill puts a stroke on every note of the selected scale instead.

Turn **Snap Time** or **Snap Pitch** off and that axis stops being divided: the fill treats it as one cell, and a brush whose size tracks the grid stretches to span it. With both off you get a single stroke covering everything, which is how you apply a brush to a whole file at once.

### What Sets the Size

The brush does. **Size ↔** and **Size ↕** work exactly as they do when you paint by hand:

- At **Grid** the stroke fills the cell it lands in, so the fill tiles edge to edge.
- At a **fixed** beat or semitone value every stroke takes that size, whatever the spacing — smaller than the cell leaves gaps, larger overlaps.
- At **Full** the stroke spans the axis.

**Anchor** is honoured too: Corner puts each stroke's onset on the grid line, Center puts its envelope peak on the cell.

### Filling Part of a File

Drag on the time legend to set a loop region and the fill covers only that span. The region belongs to the file and survives a restart, so each open file keeps its own. Click the legend to clear it, and the fill covers the whole file again.

### Variation Between Strokes

Every stroke uses the same brush, so a bare fill repeats one sound. Variation comes from modulation, which is a field across the canvas rather than a value per stroke — strokes at different places sample different values.

- A **pattern** modulator on **Strength** with a Random or Smooth Noise shape gives each stroke its own level. Take the depth far enough down and some strokes fall silent, which thins the rhythm.
- A **sequencer** modulator on Strength is a grid you draw. Draw `1 0 0 1 0 0 1 0` and the fill plays that rhythm; draw a checkerboard against a two-row pitch grid and you get one.
- Anything modulatable works the same way — pitch shift, blur amount, an effect's own controls.

To layer, fill twice. Change the grid or the brush between passes and each is its own undo step.

## Parameter Controls

- **Drag** a slider to change it; **hold Shift while dragging** to snap between that parameter's preset values (musical beat divisions, semitone intervals, and so on).
- **Click the dropdown icon** next to a numeric value to pick a preset value from a list.
- **Double-click the label** to reset a parameter to its default — this also clears every modulation amount on it.
- **Click the label** to open the parameter menu: modulation amounts, reset, exclude-from-randomization, step linking, and a **book icon** that opens this manual at the section explaining that parameter.

### Section Presets

The **⋮ menu** on an effect card or the modulator holds a list of presets for that section — starting points for the things it is usually asked to do. Pick one and the whole section changes to it. Hover a name to read what it does.

The **+** on the Presets heading keeps the section's current settings under a name of your own, and yours then appear in the same list. Every row has a **⋮** on hover: **Duplicate…** on any of them, plus **Rename…** and **Delete…** on your own. The ones that ship with the app cannot be renamed or deleted, so duplicating is how you start from one and make it yours. Modulator presets are not tied to the modulator you saved them from, so one saved on modulator 1 loads into any of the three.

Presets carry values only, so any modulation you have wired up survives loading one.

### Randomization

Every section header has a **⋮ menu** with a Randomize block:

- **Amount** – how far values are allowed to move, as a percentage of each parameter's range. Values never leave their legal range, even at the edges.
- **Include Mod.** – whether modulation amounts get randomized too.
- **Randomize** – do it.

The Effects section also shuffles effect order and enabled states. Individual parameters can be **excluded from randomization** from their label menu, so you can lock the bits you like and re-roll the rest.

### Linking Parameters Across Steps

From a parameter's label menu, toggle the **link** icon to link it across all of the brush's steps — changing it in one step changes it everywhere. Useful for keeping brush size or blend mode consistent across a multi-step brush.

---

## Working with Files

Open a file from **File → Open**, from **Open Recent**, or by **dragging an audio file onto the window** (one at a time).

Open files stack vertically in the canvas column. Each header gives you:

- The **filename** (italic when it has unsaved changes) and a **resolution badge**.
- **BPM** – this file's tempo, which drives grid snapping and every beat-based parameter.
- **Onsets** – how sensitive the hit detector is for this file. See [Onsets](#onsets).
- **Split** (scissors) – see below.
- **Duplicate** – an editable copy, with its own history.
- **Minimize** – collapse it into the dock at the bottom of the canvas area. A docked file stays open and can still be used as a source; click it to bring it back.
- **Fullscreen** – expand it to fill the canvas area.
- **Close**.

The active file has an orange border; click any file to make it active. `Tab` / `Shift+Tab` cycle through them.

Files you create in-app (New File, duplicates, stems) are **fully persisted** — they're backed by their own on-disk history, so quitting never loses them, and they get a real path when you Save As.

### Splitting a File

The scissors menu on each file header:

- **Split Harmonic and Percussive (HPSS)** – separates the file into harmonic and percussive layers.
- **Split into N Parts (NMF)…** – non-negative matrix factorization into any number of components, ordered low-to-high by spectral centroid.
- **Split Drums / Bass / Other / Vocals (AI)** – neural stem separation using htdemucs. macOS only; downloads the model on first use and caches it in `~/.noise-canvas/models/` so it survives app updates.

### Stem Groups

Every split produces a **stem group**: the parts stay ordinary files — every brush and effect works on them unchanged — but they're bracketed together in the UI, share a colour, and remember that their coefficients still sum back to the original.

- **Sync view** – zoom and scroll follow each other across all members.
- **Merge** – sums the group back into a new file, in the coefficient domain, so a split-then-merge round trip is lossless. The parts stay open.
- **Close group** – closes every member with one confirmation.

This is the resample loop: split, paint on one part, merge back.

### Onsets

Every file is scanned for **onsets** — the moments where a new sound starts. They're detected from the analysis itself, not from the tempo, so they follow what's actually in the audio however loosely it was played.

Onsets show up in three places:

- **The onset strip** – a thin row of markers directly above the spectrogram, one line per detected hit. Brighter lines are stronger onsets.
- **Onsets sensitivity** – the **Onsets** control in the file header. It sets how far down this file's own level range a hit still counts: **0%** keeps only the loudest, **100%** keeps everything the detector found. Because the range is per-file, the same percentage means something comparable on a quiet pad and a hot drum loop. It applies to that file's path, so it survives closing and reopening.
- **Onset snapping** – set the time grid (**Beats**) to **Onsets** in the transport bar. Strokes then snap to detected hits instead of beat divisions, so a stroke lands exactly on a transient rather than near it. Pair it with **Anchor = Corner** in [Options](#options) so the cursor is the stroke's own onset.

Onsets also drive the [warp algorithms](#warp-algorithms): **Neutral** re-anchors phase at each detected onset when it moves audio, which is what keeps a moved drum hit cracking instead of smearing into pre-echo. Lower the sensitivity if a busy file is being over-anchored; raise it if quiet hits are smearing.

Onsets are recomputed for the region around a stroke after you paint, so they track your edits rather than describing the file you loaded.

### Navigating the Canvas

Time axis, on the spectrogram itself:

- **Right-click drag** – pan, with momentum.
- **Pinch**, or **`Cmd`/`Ctrl` + scroll** – zoom in time, around the cursor.
- **Two-finger horizontal scroll** – pan.
- **Vertical scroll** – scrolls the file list rather than the file.

Pitch axis, on the **pitch legend** down the left edge:

- **Drag left/right** – zoom in pitch, around the point you grabbed.
- **Drag up/down** – scroll through the frequency range (once zoomed in).

When zoomed in far enough, the pitch legend turns into a piano keyboard so you can see where the notes are.

On the **time legend** along the bottom:

- **Click** – set the playback start position (snapped to the grid).
- **Drag** – set a loop region, which also moves the playback start to its beginning.

Zoom and scroll are remembered per file across restarts, and files in a [stem group](#stem-groups) with **Sync view** enabled share all four (time zoom, time scroll, pitch zoom, pitch scroll).

---

## History

Every edit you make is captured in the **History** panel — but it's a **branching tree**, not a flat undo list. If you undo a few steps and then paint something new, the steps you undid aren't thrown away: they stay as a separate branch you can return to at any time. This lets you explore variations freely without ever painting yourself into a corner.

Each node is a snapshot of the file at that point. The **current** state is highlighted, and every node shows its label and how long ago it was made.

- **Jump to any state** – click a node to instantly return the file to it.
- **Undo / Redo** – the arrows at the top of the panel step to the parent node (undo) or the most recently visited child (redo). `Cmd/Ctrl+Z` and `Shift+Cmd/Ctrl+Z` do the same.
- **Rename** – double-click a node (or right-click → Rename).
- **Favorite** – right-click → Favorite to star the states you like.
- **Export branch…** – renders out the audio for that node's lineage, one numbered WAV per node from the root down. (In the Ableton extension there's also **Export branch to Live**.)
- **Delete branch** – removes a node and everything downstream of it.

The panel's **⋮ menu** adds **Export History…**, **Export Favorites…**, and **Purge History** — which shows how much disk the tree is using and clears it to reclaim space while leaving the current state untouched.

Under the hood each stroke is stored as a compressed delta against its parent, with full snapshots at intervals, so a long session's tree stays small. History lives on disk per file, so the whole tree survives quitting and reopening — it's only deleted when you explicitly close the file.

---

## Transport and Output

The transport bar, left to right:

- **Link** – toggle **Ableton Link** to sync tempo and start/stop with other Link-enabled apps on the network. The tooltip shows the peer count; **right-click** the button for latency compensation.
- **Play / Stop** (`Space`), **Loop**, and **Auto-play stroke** (the brush icon) — when active, each stroke automatically plays back the region you just painted.
- **Playback time**.
- **Beats / Snap** and **Semis / Snap** – grid spacing and snapping per axis. Set the semitone grid to **Scale** to snap to the selected scale instead of a fixed interval, and the beat grid to **Onsets** to snap to the file's detected hits instead of a division (see [Onsets](#onsets)).
- **Swing** – swing feel for the time grid. 0% is straight, ~67% is a triplet feel, 100% shifts odd grid lines by half a cell.
- **Tonic / Type** – the scale used for pitch snapping and for scale-based effects and modulation.
- **Output meter** and **gain-reduction meter**.
- **Limiter** – bakes a true-peak limiter into the synthesized audio so playback and export can't clip. Bypass it to hear or print the raw synthesis.
- **?** – outlines every area of the window at once. See [Getting Help](#getting-help).

Audio is resynthesized incrementally after every stroke, so what you hear is always the real thing, not a preview.

---

## Menus

**File**

- **New** (`Cmd/Ctrl+N`) – create an empty file (sample rate, BPM, length in beats).
- **Open…** (`Cmd/Ctrl+O`) / **Open Recent** – load existing audio. The recent list holds 20 files and persists across sessions.
- **Save** (`Cmd/Ctrl+S`) – write back over the original. Saves are atomic, so a crash mid-write can't corrupt your file.
- **Save As…** (`Cmd/Ctrl+Shift+S`).
- **Save Version** (`Cmd/Ctrl+Alt+S`) – save a numbered copy alongside the original without overwriting it.
- **Close File** (`Cmd/Ctrl+W`).
- **Export History…**.

**Edit**

- **Undo / Redo** (`Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z`).
- **Restore Original** – reload the unedited file.
- **Re-analyze File** – regenerate the analysis, optionally at a different resolution (Best Time → Balanced → Best Pitch). This is non-destructive: it adds a node to the history tree rather than replacing it.
- **Duplicate File** (`Cmd/Ctrl+D`).
- **Double Length / Half Length** – stretch or shrink the file's length.

**View**

- **Compact UI** (`Cmd/Ctrl+Shift+C`).

**Help**

- **Manual** (`Cmd/Ctrl+/`) – open this document in a window inside the app.
- **Run Walkthrough** – replay the first-run tour at any time. See [Getting Help](#getting-help).

**Updates**

**Check for Updates…** lives in the **Noise Canvas** app menu on macOS and under **Help** everywhere else, and will tell you whether a newer version exists. Installing it is a manual job: grab the new build from the [Releases page](https://github.com/robclouth/noise-canvas/releases) and replace your copy. Because the app isn't code-signed, it can't update itself in place.

---

## Keyboard Shortcuts

File and Edit shortcuts (`Cmd/Ctrl+N`, `+O`, `+S`, `+W`, `+D`, …) are listed under [Menus](#menus).

| Key                   | Action                                                 |
| --------------------- | ------------------------------------------------------ |
| `Space`               | Play / stop                                            |
| `Arrow keys`          | Move the brush by one grid cell                        |
| `Enter`               | Apply the brush at the current position                |
| `-` / `=`             | Decrease / increase the time grid                      |
| `Shift` + `-` / `=`   | Decrease / increase the pitch grid                     |
| `Tab` / `Shift+Tab`   | Next / previous file                                   |
| `1`–`9`, `0`          | Select the first ten brushes                           |
| `a`–`z`               | Select the brush bound to that key                     |
| Hold `Shift` + click  | Pick a source file and position                        |
| `Cmd`/`Ctrl` + scroll | Zoom                                                   |
| Right-click drag      | Pan                                                    |
| `Cmd/Ctrl+Z`          | Undo                                                   |
| `Shift+Cmd/Ctrl+Z`    | Redo                                                   |
| `Cmd/Ctrl+Shift+C`    | Toggle compact UI                                      |
| `?`                   | Outline every area (see [Getting Help](#getting-help)) |
| `Cmd/Ctrl+/`          | Open this manual                                       |

---

## Getting Help

Six places, each answering a different question.

| Surface            | How you get there                                         | What it answers                     |
| ------------------ | --------------------------------------------------------- | ----------------------------------- |
| **Tooltip**        | Hover any control for a second                            | What does this one control do?      |
| **Parameter menu** | Click a parameter's label, then the book icon             | …and where is it explained in full? |
| **`?` overlay**    | The **?** button in the transport, or the `?` key         | What is all this?                   |
| **Deep tour**      | Click an area in the `?` overlay → **Show me around**     | How does this part work?            |
| **Walkthrough**    | Offered on first launch; **Help → Run Walkthrough** after | Where is everything?                |
| **This manual**    | **Help → Manual** (`Cmd/Ctrl+/`), or any book icon        | What does this do, exactly?         |

The `?` overlay dims the window and brightens whatever you point at, with a description beside it. It covers regions, parameters and every button and widget, down to individual controls, so pointing at something is the way to ask what it is. Each card offers that area's tour, if it has one, and the part of this manual that explains it. Menus and popovers are covered too — open one first, then press `?`, and the controls inside it answer like any other. Press `?` or `Esc` to close it.

Every tooltip and every overlay description comes from the same sentence, so the two can never tell you different things.

Deep tours don't ask you to do anything — they run straight through their area. The first-run walkthrough does, twice: it makes you add an effect and paint a stroke, so you finish it having built a working brush by hand.

The manual is bundled with the app, so it works offline and always describes the build you're running rather than whatever is on the default branch. It has a search box at the top that filters to matching sections.

Separately, [**Recipes**](./recipes.md) covers what to actually _do_ with all this — start-to-finish walkthroughs of specific moves. Those live online rather than in the build, because they grow between releases. The `?` overlay links to the ones relevant to whatever area you clicked.

---

## Where Things Are Saved

```
Documents/Noise Canvas/Presets/               brush presets (.json)
Documents/Noise Canvas/Presets/Effects/       your effect presets
Documents/Noise Canvas/Presets/Modulators/    your modulator presets
Documents/Noise Canvas/Textures/              your own modulator images
~/.noise-canvas/models/             downloaded AI separation models
<user data>/history/<fileId>/       per-file history trees
```

`<user data>` is Electron's per-app data directory — `~/Library/Application Support/…` on macOS, `%APPDATA%\…` on Windows, `~/.config/…` on Linux. History is the one that grows: each file's tree is stored there until you close the file or use **Purge History**, and the History panel's ⋮ menu shows the current size.

Your open files, their zoom and scroll positions, BPMs, brushes, and window settings are all persisted too, so the app reopens where you left it.

---

## Working with Ableton Live

**As an external sample editor:**

1. In **Live Preferences → File/Folder**, set **Noise Canvas** as your _External Sample Editor_.
2. In Live, right-click a sample and select **Edit**.
3. The sample opens in Noise Canvas.
4. Make your edits, save, and close.
5. Live automatically reloads the updated version.

No exporting, importing, or manual refreshing required.

**As a Live extension (beta):** Noise Canvas also builds as an Ableton Live 12 extension (`.ablx`), which embeds the whole editor inside Live. Right-click an audio clip → **Edit in Noise Canvas**, edit, and render straight back into the set as a new clip — including **Export branch to Live** from the history panel. This requires a Live build with Extensions support and is distributed alongside each release. See [`src/extension/README.md`](../src/extension/README.md).

**Ableton Link** works regardless of which route you take — enable it in the transport bar to lock tempo and transport to Live or anything else on the network.
